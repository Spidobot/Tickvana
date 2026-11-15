// Users and groups: admin API plus the search that user pickers call.
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import { requireStaff, requireUser } from "../auth/routes.js";
import {
  createResetToken,
  hashPassword,
  normalizeEmail,
} from "../auth/store.js";
import { escapeLike, likeCi } from "../db/dialect.js";
import { uuidv7 } from "../db/id.js";
import type { Mailer } from "../mail/index.js";
import type { Permissions } from "../permissions/index.js";
import type { Queue } from "../queue/index.js";
import type { CoreDb } from "../schema.js";
import { AppError } from "../server/index.js";

const MANAGE = "user.manage";
const INVITE_MS = 7 * 24 * 60 * 60 * 1000;

export interface UserRouteOptions {
  db: Kysely<CoreDb>;
  permissions: Permissions;
  queue: Queue;
  mailer: Mailer;
  secretKey: string;
  /** Link in the invitation mail. Same page as password reset. */
  setPasswordUrl: (token: string) => string;
}

const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  kind: z.enum(["internal", "customer", "service"]),
  active: z.boolean(),
  locale: z.string(),
  timezone: z.string(),
});
type UserOut = z.infer<typeof userSchema>;

const toUser = (u: CoreDb["core_user"]): UserOut => ({
  id: u.id,
  email: u.email,
  displayName: u.display_name,
  kind: u.kind,
  active: u.active,
  locale: u.locale,
  timezone: u.timezone,
});

const groupSchema = z.object({ id: z.string(), name: z.string() });
const idParam = z.object({ id: z.string() });

const profile = {
  displayName: z.string().trim().min(1).max(200),
  locale: z.string().min(2).max(10),
  timezone: z.string().min(1).max(64),
};

/** Registers /core/users and /core/groups. */
export async function installUserRoutes(
  scope: FastifyInstance,
  opts: UserRouteOptions,
): Promise<void> {
  const { db, permissions, queue } = opts;
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const manage = { permission: MANAGE };
  const custom = { permission: "custom" as const };

  /** Staff may look up people. Portal customers may not enumerate accounts. */
  const loadUser = async (id: string) => {
    const u = await db
      .selectFrom("core_user")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!u) throw new AppError(404, "not_found", "Not found");
    return u;
  };
  const duplicate = (what: string) =>
    new AppError(409, "conflict", `${what} is already in use`);

  r.get(
    "/core/users",
    {
      config: custom,
      schema: {
        querystring: z.object({
          q: z.string().max(200).default(""),
          kind: userSchema.shape.kind.optional(),
          /** Deactivated accounts, for the admin list. Needs user.manage. */
          includeInactive: z.stringbool().default(false),
          limit: z.coerce.number().int().min(1).max(100).default(20),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(userSchema) },
      },
    },
    async (req) => {
      const me = requireStaff(req);
      const { q, kind, includeInactive, limit, offset } = req.query;
      if (includeInactive) await permissions.require(me, MANAGE);

      let query = db.selectFrom("core_user").selectAll();
      if (!includeInactive) query = query.where("active", "=", true);
      if (kind) query = query.where("kind", "=", kind);
      if (q.trim()) {
        const pattern = `%${escapeLike(q.trim())}%`;
        query = query.where((eb) =>
          eb.or([
            likeCi(eb.ref("display_name"), pattern),
            likeCi(eb.ref("email"), pattern),
          ]),
        );
      }
      const rows = await query
        .orderBy("display_name")
        .orderBy("id")
        .limit(limit)
        .offset(offset)
        .execute();
      return rows.map(toUser);
    },
  );

  r.get(
    "/core/users/:id",
    {
      config: custom,
      schema: { params: idParam, response: { 200: userSchema } },
    },
    async (req) => {
      requireStaff(req);
      return toUser(await loadUser(req.params.id));
    },
  );

  r.post(
    "/core/users",
    {
      config: manage,
      schema: {
        body: z.object({
          email: z.email().max(320),
          displayName: profile.displayName,
          kind: userSchema.shape.kind.default("internal"),
          locale: profile.locale.default("en"),
          timezone: profile.timezone.default("UTC"),
          /** Set a password directly … */
          password: z.string().min(10).max(200).optional(),
          /** … or mail a link that lets the person choose one. */
          invite: z.boolean().default(false),
        }),
        response: { 201: userSchema },
      },
    },
    async (req, reply) => {
      const actor = requireUser(req);
      const now = new Date();
      const row: CoreDb["core_user"] = {
        id: uuidv7(),
        email: normalizeEmail(req.body.email),
        display_name: req.body.displayName,
        password_hash: req.body.password
          ? await hashPassword(req.body.password)
          : null,
        kind: req.body.kind,
        active: true,
        locale: req.body.locale,
        timezone: req.body.timezone,
        created_at: now,
        updated_at: now,
      };
      await db.transaction().execute(async (trx) => {
        const taken = await trx
          .selectFrom("core_user")
          .select("id")
          .where("email", "=", row.email)
          .executeTakeFirst();
        if (taken) throw duplicate("This e-mail address");
        await trx.insertInto("core_user").values(row).execute();
        await queue.emit(trx, {
          type: "user.created",
          actorId: actor.id,
          entityType: "user",
          entityId: row.id,
        });
      });

      if (req.body.invite) {
        const invite = await createResetToken(
          db,
          opts.secretKey,
          row.email,
          now,
          INVITE_MS,
        );
        const de = row.locale.startsWith("de");
        await opts.mailer.send(db, {
          to: row.email,
          subject: de ? "Dein Konto wurde angelegt" : "Your account is ready",
          body: [
            de
              ? `${actor.displayName} hat ein Konto für dich angelegt. Der Link gilt sieben Tage.`
              : `${actor.displayName} created an account for you. The link is valid for seven days.`,
          ],
          action: {
            label: de ? "Passwort festlegen" : "Choose a password",
            url: opts.setPasswordUrl(invite!.token),
          },
        });
      }
      return reply.status(201).send(toUser(row));
    },
  );

  r.patch(
    "/core/users/:id",
    {
      config: custom,
      schema: {
        params: idParam,
        body: z
          .object({
            ...profile,
            email: z.email().max(320),
            kind: userSchema.shape.kind,
            active: z.boolean(),
          })
          .partial(),
        response: { 200: userSchema },
      },
    },
    async (req) => {
      const actor = requireUser(req);
      const { email, kind, active, ...own } = req.body;
      const adminFields =
        email !== undefined || kind !== undefined || active !== undefined;
      // Everyone edits their own name, language and time zone. The rest is for user managers.
      if (adminFields || actor.id !== req.params.id)
        await permissions.require(actor, MANAGE);
      if (active === false && actor.id === req.params.id) {
        throw new AppError(
          409,
          "conflict",
          "You cannot deactivate your own account",
        );
      }

      const before = await loadUser(req.params.id);
      const next = email === undefined ? undefined : normalizeEmail(email);
      await db.transaction().execute(async (trx) => {
        if (next && next !== before.email) {
          const taken = await trx
            .selectFrom("core_user")
            .select("id")
            .where("email", "=", next)
            .executeTakeFirst();
          if (taken) throw duplicate("This e-mail address");
        }
        await trx
          .updateTable("core_user")
          .set({
            ...(own.displayName !== undefined && {
              display_name: own.displayName,
            }),
            ...(own.locale !== undefined && { locale: own.locale }),
            ...(own.timezone !== undefined && { timezone: own.timezone }),
            ...(next !== undefined && { email: next }),
            ...(kind !== undefined && { kind }),
            ...(active !== undefined && { active }),
            updated_at: new Date(),
          })
          .where("id", "=", before.id)
          .execute();
        const deactivated = before.active && active === false;
        // Accounts are never deleted: history keeps pointing at them.
        if (deactivated)
          await trx
            .deleteFrom("core_session")
            .where("user_id", "=", before.id)
            .execute();
        await queue.emit(trx, {
          type: deactivated ? "user.deactivated" : "user.updated",
          actorId: actor.id,
          entityType: "user",
          entityId: before.id,
        });
      });
      return toUser(await loadUser(before.id));
    },
  );

  r.get(
    "/core/groups",
    { config: custom, schema: { response: { 200: z.array(groupSchema) } } },
    async (req) => {
      requireStaff(req);
      return db
        .selectFrom("core_group")
        .select(["id", "name"])
        .orderBy("name")
        .execute();
    },
  );

  const groupBody = z.object({ name: z.string().trim().min(1).max(200) });
  const loadGroup = async (id: string) => {
    const g = await db
      .selectFrom("core_group")
      .select(["id", "name"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!g) throw new AppError(404, "not_found", "Not found");
    return g;
  };
  const nameTaken = async (
    trx: Kysely<CoreDb>,
    name: string,
    exceptId?: string,
  ) => {
    const g = await trx
      .selectFrom("core_group")
      .select("id")
      .where("name", "=", name)
      .executeTakeFirst();
    if (g && g.id !== exceptId) throw duplicate("This group name");
  };

  r.post(
    "/core/groups",
    {
      config: manage,
      schema: { body: groupBody, response: { 201: groupSchema } },
    },
    async (req, reply) => {
      const group = { id: uuidv7(), name: req.body.name };
      await db.transaction().execute(async (trx) => {
        await nameTaken(trx, group.name);
        await trx
          .insertInto("core_group")
          .values({ ...group, created_at: new Date() })
          .execute();
        await queue.emit(trx, {
          type: "group.created",
          actorId: requireUser(req).id,
          entityType: "group",
          entityId: group.id,
        });
      });
      return reply.status(201).send(group);
    },
  );

  r.patch(
    "/core/groups/:id",
    {
      config: manage,
      schema: {
        params: idParam,
        body: groupBody,
        response: { 200: groupSchema },
      },
    },
    async (req) => {
      const group = await loadGroup(req.params.id);
      await db.transaction().execute(async (trx) => {
        await nameTaken(trx, req.body.name, group.id);
        await trx
          .updateTable("core_group")
          .set({ name: req.body.name })
          .where("id", "=", group.id)
          .execute();
      });
      return { id: group.id, name: req.body.name };
    },
  );

  r.delete(
    "/core/groups/:id",
    {
      config: manage,
      schema: { params: idParam, response: { 204: z.null() } },
    },
    async (req, reply) => {
      const group = await loadGroup(req.params.id);
      await db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("core_global_grant")
          .where("grantee_type", "=", "group")
          .where("grantee_id", "=", group.id)
          .execute();
        // Members go with the group (cascade). Apps drop their own grants on this event.
        await trx.deleteFrom("core_group").where("id", "=", group.id).execute();
        await queue.emit(trx, {
          type: "group.deleted",
          actorId: requireUser(req).id,
          entityType: "group",
          entityId: group.id,
        });
      });
      return reply.status(204).send(null);
    },
  );

  r.get(
    "/core/groups/:id/members",
    {
      config: custom,
      schema: { params: idParam, response: { 200: z.array(userSchema) } },
    },
    async (req) => {
      requireStaff(req);
      const group = await loadGroup(req.params.id);
      const rows = await db
        .selectFrom("core_group_member")
        .innerJoin("core_user", "core_user.id", "core_group_member.user_id")
        .selectAll("core_user")
        .where("group_id", "=", group.id)
        .orderBy("display_name")
        .execute();
      return rows.map(toUser);
    },
  );

  const memberParams = z.object({ id: z.string(), userId: z.string() });

  r.put(
    "/core/groups/:id/members/:userId",
    {
      config: manage,
      schema: { params: memberParams, response: { 204: z.null() } },
    },
    async (req, reply) => {
      const group = await loadGroup(req.params.id);
      const user = await loadUser(req.params.userId);
      await db.transaction().execute(async (trx) => {
        const member = { group_id: group.id, user_id: user.id };
        const exists = await trx
          .selectFrom("core_group_member")
          .select("user_id")
          .where("group_id", "=", group.id)
          .where("user_id", "=", user.id)
          .executeTakeFirst();
        if (!exists)
          await trx.insertInto("core_group_member").values(member).execute();
      });
      return reply.status(204).send(null);
    },
  );

  r.delete(
    "/core/groups/:id/members/:userId",
    {
      config: manage,
      schema: { params: memberParams, response: { 204: z.null() } },
    },
    async (req, reply) => {
      await db
        .deleteFrom("core_group_member")
        .where("group_id", "=", req.params.id)
        .where("user_id", "=", req.params.userId)
        .execute();
      return reply.status(204).send(null);
    },
  );
}
