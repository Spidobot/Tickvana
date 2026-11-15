// Outgoing webhooks: every event that matches a webhook's filter is posted
// to its URL as JSON, signed with HMAC-SHA256, from a background job with
// retries. Targets in private networks are refused unless an admin allows them.
import { createHmac, randomBytes } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import { uuidv7 } from "../db/id.js";
import { SYSTEM_ADMIN } from "../permissions/index.js";
import type { Queue, StoredEvent } from "../queue/index.js";
import type { CoreDb } from "../schema.js";
import { AppError } from "../server/index.js";
import {
  decryptSecret,
  encryptSecret,
  getSetting,
  setSetting,
} from "../settings.js";

const JOB = "webhook.deliver";
const SETTING = "webhooks";
const TIMEOUT_MS = 10_000;
const settingsSchema = z.object({
  allowPrivateTargets: z.boolean().default(false),
});

/** True for addresses inside the machine or a private network. */
export function isPrivateAddress(address: string): boolean {
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  return (
    v6 === "::1" ||
    v6 === "::" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe80") ||
    v6.startsWith("ff")
  );
}

/** Throws when a URL may not be called: wrong scheme, or it resolves into a private network. */
export async function assertPublicTarget(
  url: string,
  allowPrivate: boolean,
): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new Error("Only http and https targets are allowed");
  await assertPublicHost(parsed.hostname.replace(/^\[|\]$/g, ""), allowPrivate);
}

/** Throws when a host name resolves into a private network. Also for mail servers. */
export async function assertPublicHost(
  host: string,
  allowPrivate: boolean,
): Promise<void> {
  if (allowPrivate) return;
  // Delivery connects through guardedLookup, so the address used is checked again.
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress))
    throw new Error("The target lies in a private network");
}

/**
 * A DNS lookup for sockets that refuses private addresses. The connection
 * uses exactly the address checked here, so a name that resolves somewhere
 * else a moment later (DNS rebinding) cannot slip through.
 */
export function guardedLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      if (
        !allowPrivate &&
        (addresses.length === 0 ||
          addresses.some((a) => isPrivateAddress(a.address)))
      )
        return callback(
          new Error("The target lies in a private network"),
          "",
          0,
        );
      if (options.all)
        return (callback as unknown as (e: null, a: LookupAddress[]) => void)(
          null,
          addresses,
        );
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

/** POSTs and returns the status code. No redirects: they could point anywhere. */
function post(
  url: string,
  allowPrivate: boolean,
  body: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = (target.protocol === "https:" ? httpsRequest : httpRequest)(
      target,
      {
        method: "POST",
        headers: { ...headers, "content-length": Buffer.byteLength(body) },
        lookup: guardedLookup(allowPrivate),
        timeout: TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("timeout", () => {
      const e = new Error("timeout");
      e.name = "TimeoutError";
      req.destroy(e);
    });
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * Resolves a host once and returns an address that may be used. Connect to
 * that address (with the name for TLS) so the check and the connection see
 * the same answer.
 */
export async function resolvePublicHost(
  host: string,
  allowPrivate: boolean,
): Promise<string> {
  if (isIP(host)) {
    if (!allowPrivate && isPrivateAddress(host))
      throw new Error("The target lies in a private network");
    return host;
  }
  const addresses = (await lookup(host, { all: true })).map((a) => a.address);
  if (
    addresses.length === 0 ||
    (!allowPrivate && addresses.some(isPrivateAddress))
  )
    throw new Error("The target lies in a private network");
  return addresses[0]!;
}

/** Whether an admin allowed webhooks and mail fetching into private networks. */
export async function privateTargetsAllowed(
  db: Kysely<CoreDb>,
): Promise<boolean> {
  return (await getSetting(db, SETTING, settingsSchema)).allowPrivateTargets;
}

/** Header value: sha256=<hex of HMAC(secret, timestamp + "." + body)>. */
export function signature(
  secret: string,
  timestamp: string,
  body: string,
): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

const matches = (pattern: string, type: string) =>
  pattern === "*" ||
  pattern === type ||
  (pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1)));

export interface WebhookOptions {
  db: Kysely<CoreDb>;
  queue: Queue;
  secretKey: string;
}

/** Subscribes to all events and registers the delivery job. Call once per process. */
export function installWebhookDelivery({
  db,
  queue,
  secretKey,
}: WebhookOptions): void {
  queue.on("webhooks", ["*"], async (event) => {
    const hooks = await db
      .selectFrom("core_webhook")
      .select(["id", "event_filter_json"])
      .where("active", "=", true)
      .execute();
    for (const hook of hooks) {
      const filter = JSON.parse(hook.event_filter_json) as string[];
      if (filter.some((p) => matches(p, event.type)))
        await queue.enqueue(db, JOB, { webhookId: hook.id, eventId: event.id });
    }
  });

  queue.job(JOB, async (payload) => {
    const { webhookId, eventId } = payload as {
      webhookId: string;
      eventId: string;
    };
    const hook = await db
      .selectFrom("core_webhook")
      .selectAll()
      .where("id", "=", webhookId)
      .executeTakeFirst();
    const row = await db
      .selectFrom("core_event")
      .selectAll()
      .where("id", "=", eventId)
      .executeTakeFirst();
    if (!hook?.active || !row) return;
    const event: StoredEvent = {
      id: row.id,
      type: row.type,
      actorId: row.actor_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      payload: JSON.parse(row.payload_json),
      createdAt: row.created_at,
    };
    const attempt =
      (
        await db
          .selectFrom("core_webhook_delivery")
          .select("id")
          .where("webhook_id", "=", hook.id)
          .where("event_id", "=", event.id)
          .execute()
      ).length + 1;
    const result = await deliver(hook, event, attempt);
    // Throwing hands the job back to the queue, which retries with backoff.
    if (result.error) throw new Error(result.error);
  });

  async function deliver(
    hook: CoreDb["core_webhook"],
    event: StoredEvent,
    attempt: number,
  ) {
    const body = JSON.stringify({
      id: event.id,
      type: event.type,
      actorId: event.actorId,
      entityType: event.entityType,
      entityId: event.entityId,
      payload: event.payload,
      createdAt: event.createdAt,
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const started = Date.now();
    let status: number | null = null;
    let error: string | null = null;
    try {
      const { allowPrivateTargets } = await getSetting(
        db,
        SETTING,
        settingsSchema,
      );
      await assertPublicTarget(hook.url, allowPrivateTargets);
      status = await post(hook.url, allowPrivateTargets, body, {
        "content-type": "application/json",
        "user-agent": "Webhook-Delivery",
        "x-webhook-event": event.type,
        "x-webhook-delivery": event.id,
        "x-webhook-timestamp": timestamp,
        "x-webhook-signature": signature(
          decryptSecret(secretKey, hook.secret),
          timestamp,
          body,
        ),
      });
      if (status < 200 || status >= 300)
        error = `The target answered ${status}`;
    } catch (e) {
      error =
        e instanceof Error
          ? e.name === "TimeoutError"
            ? `No answer within ${TIMEOUT_MS / 1000} seconds`
            : e.message
          : String(e);
    }
    await db
      .insertInto("core_webhook_delivery")
      .values({
        id: uuidv7(),
        webhook_id: hook.id,
        event_id: event.id,
        event_type: event.type,
        attempt,
        status_code: status,
        error,
        duration_ms: Date.now() - started,
        created_at: new Date(),
      })
      .execute();
    return { status, error };
  }

  deliverNow = deliver;
}

/** Set by installWebhookDelivery, used by the test button. */
let deliverNow:
  | ((
      hook: CoreDb["core_webhook"],
      event: StoredEvent,
      attempt: number,
    ) => Promise<{ status: number | null; error: string | null }>)
  | undefined;

/** Admin API under /core/webhooks. The secret is shown once, on creation. */
export async function installWebhookRoutes(
  scope: FastifyInstance,
  { db, secretKey }: WebhookOptions,
): Promise<void> {
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const admin = { permission: SYSTEM_ADMIN };
  const idParam = z.object({ id: z.string() });
  const filter = z
    .array(
      z
        .string()
        .regex(
          /^(\*|[a-z_]+(\.[a-z_]+)*(\.\*)?)$/,
          "like issue.created, issue.* or *",
        ),
    )
    .min(1)
    .max(50);
  const hookSchema = z.object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    events: z.array(z.string()),
    active: z.boolean(),
    createdAt: z.string(),
  });
  const present = (h: CoreDb["core_webhook"]): z.infer<typeof hookSchema> => ({
    id: h.id,
    name: h.name ?? "",
    url: h.url,
    events: JSON.parse(h.event_filter_json),
    active: h.active,
    createdAt: h.created_at.toISOString(),
  });
  const load = async (id: string) =>
    (await db
      .selectFrom("core_webhook")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst()) ??
    Promise.reject(new AppError(404, "not_found", "Not found"));
  const checkUrl = async (url: string) => {
    try {
      // Saving checks the scheme only: the address is checked at every delivery.
      await assertPublicTarget(url, true);
    } catch (e) {
      throw new AppError(400, "validation", (e as Error).message);
    }
  };

  r.get(
    "/core/webhooks",
    {
      config: admin,
      schema: {
        response: {
          200: z.object({
            allowPrivateTargets: z.boolean(),
            webhooks: z.array(hookSchema),
          }),
        },
      },
    },
    async () => ({
      allowPrivateTargets: (await getSetting(db, SETTING, settingsSchema))
        .allowPrivateTargets,
      webhooks: (
        await db
          .selectFrom("core_webhook")
          .selectAll()
          .orderBy("created_at")
          .execute()
      ).map(present),
    }),
  );

  r.put(
    "/core/webhooks/settings",
    {
      config: admin,
      schema: { body: settingsSchema, response: { 204: z.null() } },
    },
    async (req, reply) => {
      await setSetting(db, SETTING, req.body);
      return reply.status(204).send(null);
    },
  );

  r.post(
    "/core/webhooks",
    {
      config: admin,
      schema: {
        body: z.object({
          name: z.string().trim().max(200).default(""),
          url: z.url().max(2000),
          events: filter,
        }),
        response: { 201: hookSchema.extend({ secret: z.string() }) },
      },
    },
    async (req, reply) => {
      await checkUrl(req.body.url);
      const secret = randomBytes(24).toString("base64url");
      const hook: CoreDb["core_webhook"] = {
        id: uuidv7(),
        name: req.body.name,
        url: req.body.url,
        secret: encryptSecret(secretKey, secret),
        event_filter_json: JSON.stringify(req.body.events),
        active: true,
        created_at: new Date(),
      };
      await db.insertInto("core_webhook").values(hook).execute();
      return reply.status(201).send({ ...present(hook), secret });
    },
  );

  r.patch(
    "/core/webhooks/:id",
    {
      config: admin,
      schema: {
        params: idParam,
        body: z
          .object({
            name: z.string().trim().max(200),
            url: z.url().max(2000),
            events: filter,
            active: z.boolean(),
          })
          .partial(),
        response: { 200: hookSchema },
      },
    },
    async (req) => {
      const hook = await load(req.params.id);
      if (req.body.url) await checkUrl(req.body.url);
      const set = {
        ...(req.body.name !== undefined && { name: req.body.name }),
        ...(req.body.url !== undefined && { url: req.body.url }),
        ...(req.body.events !== undefined && {
          event_filter_json: JSON.stringify(req.body.events),
        }),
        ...(req.body.active !== undefined && { active: req.body.active }),
      };
      if (Object.keys(set).length)
        await db
          .updateTable("core_webhook")
          .set(set)
          .where("id", "=", hook.id)
          .execute();
      return present({ ...hook, ...set });
    },
  );

  r.delete(
    "/core/webhooks/:id",
    { config: admin, schema: { params: idParam, response: { 204: z.null() } } },
    async (req, reply) => {
      await db
        .deleteFrom("core_webhook")
        .where("id", "=", (await load(req.params.id)).id)
        .execute();
      return reply.status(204).send(null);
    },
  );

  r.get(
    "/core/webhooks/:id/deliveries",
    {
      config: admin,
      schema: {
        params: idParam,
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              eventId: z.string(),
              eventType: z.string(),
              attempt: z.number(),
              statusCode: z.number().nullable(),
              error: z.string().nullable(),
              durationMs: z.number(),
              createdAt: z.string(),
            }),
          ),
        },
      },
    },
    async (req) => {
      const rows = await db
        .selectFrom("core_webhook_delivery")
        .selectAll()
        .where("webhook_id", "=", (await load(req.params.id)).id)
        .orderBy("created_at", "desc")
        .limit(100)
        .execute();
      return rows.map((d) => ({
        id: d.id,
        eventId: d.event_id,
        eventType: d.event_type,
        attempt: d.attempt,
        statusCode: d.status_code,
        error: d.error,
        durationMs: d.duration_ms,
        createdAt: d.created_at.toISOString(),
      }));
    },
  );

  r.post(
    "/core/webhooks/:id/test",
    {
      config: admin,
      schema: {
        params: idParam,
        response: {
          200: z.object({
            statusCode: z.number().nullable(),
            error: z.string().nullable(),
          }),
        },
      },
    },
    async (req) => {
      const hook = await load(req.params.id);
      const event: StoredEvent = {
        id: uuidv7(),
        type: "webhook.test",
        actorId: req.user?.id ?? null,
        entityType: "webhook",
        entityId: hook.id,
        payload: { message: "Test delivery" },
        createdAt: new Date(),
      };
      const result = await deliverNow!(hook, event, 1);
      return { statusCode: result.status, error: result.error };
    },
  );
}
