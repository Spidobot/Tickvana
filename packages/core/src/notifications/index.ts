// Notifications: who was told about which event, the in-app list, and the
// mail digest. The apps decide the recipients and how an event reads; this
// module stores, lists and mails.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import { requireUser } from "../auth/routes.js";
import type { AuthUser } from "../auth/store.js";
import { uuidv7 } from "../db/id.js";
import type { Mailer } from "../mail/index.js";
import type { Queue, StoredEvent } from "../queue/index.js";
import type { CoreDb } from "../schema.js";
import { AppError } from "../server/index.js";
import { getSetting, setSetting } from "../settings.js";

/** How one event reads to one person. */
export interface Described {
  /** One line, e.g. "WIT-12 Drucker druckt versetzt". */
  title: string;
  /** What happened, e.g. "Mira changed the priority". */
  text: string;
  /** Path on this installation that shows the thing. */
  url: string;
}
type Describe = (
  event: StoredEvent,
  /** The person who will read it: for language, and to hide what they may not see. */
  reader: AuthUser,
) => Promise<Described | null>;

export interface Notifier {
  /** Tells users about an event. Call in the transaction or job that decided the recipients. */
  notify(
    trx: Kysely<CoreDb>,
    userIds: string[],
    eventId: string,
  ): Promise<void>;
  /** Registers how events whose type starts with `prefix` read. Returning null hides the notification. */
  describe(prefix: string, fn: Describe): void;
  /** Sends one mail per user whose oldest unmailed notification is older than the quiet period. Returns the number of mails. */
  sendDigests(now?: Date): Promise<number>;
}

export interface NotifierOptions {
  secretKey: string;
  /** Origin of the installation. */
  origin: string;
  /** Path of this app's API, e.g. /tickvana/api. Used for the unsubscribe link. */
  apiBase: string;
  /** How long to collect changes before mailing, so ten edits become one mail. */
  quietMs?: number;
}

const prefsSchema = z.object({ mail: z.boolean().default(true) });
const prefsKey = (userId: string) => `user.${userId}.notifications`;

const TEXT = {
  de: {
    many: (n: number) => `${n} Neuigkeiten`,
    open: "Ansehen",
    unsubscribe: "Diese Mails abbestellen",
  },
  en: {
    many: (n: number) => `${n} updates`,
    open: "Open",
    unsubscribe: "Stop these mails",
  },
};

export function createNotifier(
  db: Kysely<CoreDb>,
  queue: Queue,
  mailer: Mailer,
  opts: NotifierOptions,
): Notifier & {
  unsubscribeToken(userId: string): string;
  userIdFromToken(token: string): string | null;
  describeEvent(
    event: StoredEvent,
    reader: AuthUser,
  ): Promise<Described | null>;
} {
  const describers: [string, Describe][] = [];
  const quietMs = opts.quietMs ?? 120_000;

  const mac = (userId: string) =>
    createHmac("sha256", opts.secretKey)
      .update(`unsubscribe\n${userId}`)
      .digest("base64url");
  const unsubscribeToken = (userId: string) => `${userId}.${mac(userId)}`;
  const userIdFromToken = (token: string) => {
    const [userId, given] = token.split(".");
    if (!userId || !given) return null;
    const a = Buffer.from(given);
    const b = Buffer.from(mac(userId));
    return a.length === b.length && timingSafeEqual(a, b) ? userId : null;
  };

  const describeEvent = async (event: StoredEvent, reader: AuthUser) => {
    const match = describers.find(([prefix]) => event.type.startsWith(prefix));
    return match ? match[1](event, reader) : null;
  };

  const toEvent = (e: CoreDb["core_event"]): StoredEvent => ({
    id: e.id,
    type: e.type,
    actorId: e.actor_id,
    entityType: e.entity_type,
    entityId: e.entity_id,
    payload: JSON.parse(e.payload_json),
    createdAt: e.created_at,
  });

  const self = {
    unsubscribeToken,
    userIdFromToken,
    describeEvent,

    async notify(trx: Kysely<CoreDb>, userIds: string[], eventId: string) {
      const unique = [...new Set(userIds)];
      if (unique.length === 0) return;
      const now = new Date();
      await trx
        .insertInto("core_notification")
        .values(
          unique.map((user_id) => ({
            id: uuidv7(),
            user_id,
            event_id: eventId,
            read_at: null,
            mailed_at: null,
            created_at: now,
          })),
        )
        .execute();
    },

    describe(prefix: string, fn: Describe) {
      describers.push([prefix, fn]);
      // Longest prefix wins.
      describers.sort((a, b) => b[0].length - a[0].length);
    },

    async sendDigests(now = new Date()) {
      const pending = await db
        .selectFrom("core_notification as n")
        .innerJoin("core_event as e", "e.id", "n.event_id")
        .selectAll("e")
        .select([
          "n.id as notification_id",
          "n.user_id",
          "n.created_at as notified_at",
          "n.read_at",
        ])
        .where("n.mailed_at", "is", null)
        .orderBy("e.id")
        .execute();
      const byUser = Map.groupBy(pending, (p) => p.user_id);
      let mails = 0;

      for (const [userId, rows] of byUser) {
        // Wait until things have been quiet for this person.
        const newest = Math.max(...rows.map((r) => r.notified_at.getTime()));
        if (now.getTime() - newest < quietMs) continue;

        const user = await db
          .selectFrom("core_user")
          .selectAll()
          .where("id", "=", userId)
          .executeTakeFirst();
        const prefs = await getSetting(db, prefsKey(userId), prefsSchema);
        // Already seen in the app, switched off, or the account is gone: nothing to mail.
        const unread = rows.filter((r) => r.read_at === null);
        const items: Described[] = [];
        if (user?.active && prefs.mail) {
          for (const r of unread) {
            const d = await describeEvent(toEvent(r), {
              id: user.id,
              email: user.email,
              displayName: user.display_name,
              kind: user.kind,
              locale: user.locale,
              timezone: user.timezone,
            });
            if (d) items.push(d);
          }
        }

        await db.transaction().execute(async (trx) => {
          const claimed = await trx
            .updateTable("core_notification")
            .set({ mailed_at: now })
            .where(
              "id",
              "in",
              rows.map((r) => r.notification_id),
            )
            .where("mailed_at", "is", null)
            .executeTakeFirst();
          // Another worker took this batch.
          if (
            claimed.numUpdatedRows !== BigInt(rows.length) ||
            items.length === 0 ||
            !user
          )
            return;
          const t = user.locale.startsWith("de") ? TEXT.de : TEXT.en;
          const titles = [...new Set(items.map((i) => i.title))];
          await mailer.send(trx, {
            to: user.email,
            subject: titles.length === 1 ? titles[0]! : t.many(items.length),
            body: [
              ...items.map((i) =>
                titles.length === 1 ? i.text : `${i.title}: ${i.text}`,
              ),
              `${t.unsubscribe}: ${opts.origin}${opts.apiBase}/core/notifications/unsubscribe?token=${encodeURIComponent(unsubscribeToken(userId))}`,
            ],
            action: { label: t.open, url: `${opts.origin}${items[0]!.url}` },
          });
          mails++;
        });
      }
      return mails;
    },
  };

  queue.every(
    "notify-digest",
    30_000,
    async () => void (await self.sendDigests()),
  );
  return self;
}

/** In-app list, read marks, preferences and the unsubscribe link, under /core/notifications. */
export async function installNotificationRoutes(
  scope: FastifyInstance,
  db: Kysely<CoreDb>,
  notifier: ReturnType<typeof createNotifier>,
): Promise<void> {
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const own = { permission: "authenticated" as const };

  const item = z.object({
    id: z.string(),
    title: z.string(),
    text: z.string(),
    url: z.string(),
    actorId: z.string().nullable(),
    createdAt: z.string(),
    read: z.boolean(),
  });

  r.get(
    "/core/notifications",
    {
      config: own,
      schema: {
        querystring: z.object({
          unread: z.stringbool().default(false),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        }),
        response: {
          200: z.object({ unreadCount: z.number(), items: z.array(item) }),
        },
      },
    },
    async (req) => {
      const user = requireUser(req);
      let query = db
        .selectFrom("core_notification as n")
        .innerJoin("core_event as e", "e.id", "n.event_id")
        .selectAll("e")
        .select(["n.id as notification_id", "n.read_at"])
        .where("n.user_id", "=", user.id);
      if (req.query.unread) query = query.where("n.read_at", "is", null);
      const rows = await query
        .orderBy("e.id", "desc")
        .limit(req.query.limit)
        .execute();
      const unread = await db
        .selectFrom("core_notification")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("user_id", "=", user.id)
        .where("read_at", "is", null)
        .executeTakeFirstOrThrow();

      const items: z.infer<typeof item>[] = [];
      for (const row of rows) {
        const event: StoredEvent = {
          id: row.id,
          type: row.type,
          actorId: row.actor_id,
          entityType: row.entity_type,
          entityId: row.entity_id,
          payload: JSON.parse(row.payload_json),
          createdAt: row.created_at,
        };
        const d = await notifier.describeEvent(event, user);
        // What the user may no longer see is not listed.
        if (d)
          items.push({
            id: row.notification_id,
            ...d,
            actorId: row.actor_id,
            createdAt: row.created_at.toISOString(),
            read: row.read_at !== null,
          });
      }
      return { unreadCount: Number(unread.count), items };
    },
  );

  r.post(
    "/core/notifications/read",
    {
      config: own,
      schema: {
        body: z.object({ ids: z.array(z.string()).max(500).optional() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      let query = db
        .updateTable("core_notification")
        .set({ read_at: new Date() })
        .where("user_id", "=", user.id)
        .where("read_at", "is", null);
      // Without ids: everything.
      if (req.body.ids) {
        if (req.body.ids.length === 0) return reply.status(204).send(null);
        query = query.where("id", "in", req.body.ids);
      }
      await query.execute();
      return reply.status(204).send(null);
    },
  );

  const prefs = z.object({ mail: z.boolean() });
  r.get(
    "/core/notifications/preferences",
    { config: own, schema: { response: { 200: prefs } } },
    (req) => getSetting(db, prefsKey(requireUser(req).id), prefsSchema),
  );
  r.put(
    "/core/notifications/preferences",
    { config: own, schema: { body: prefs, response: { 200: prefs } } },
    async (req) => {
      await setSetting(db, prefsKey(requireUser(req).id), req.body);
      return req.body;
    },
  );

  // Opened from a mail, without being signed in: the token proves who asks.
  r.get(
    "/core/notifications/unsubscribe",
    {
      config: { permission: "public" as const },
      schema: { querystring: z.object({ token: z.string().max(200) }) },
    },
    async (req, reply) => {
      const userId = notifier.userIdFromToken(req.query.token);
      if (!userId)
        throw new AppError(400, "invalid_token", "This link is not valid");
      await setSetting(db, prefsKey(userId), { mail: false });
      return reply
        .header("content-type", "text/plain; charset=utf-8")
        .send(
          "Notification mails are switched off. You can switch them on again in your account settings.",
        );
    },
  );
}
