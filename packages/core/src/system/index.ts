// System pages for administrators: sign-in settings, the audit log (which
// is core_event, CONCEPT.md §2) and background jobs with a retry for
// failed ones.
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import { getOidcConfig, setOidcConfig } from "../auth/oidc.js";
import { SYSTEM_ADMIN } from "../permissions/index.js";
import type { CoreDb } from "../schema.js";
import { AppError } from "../server/index.js";

export async function installSystemRoutes(
  scope: FastifyInstance,
  { db, secretKey }: { db: Kysely<CoreDb>; secretKey: string },
): Promise<void> {
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const config = { permission: SYSTEM_ADMIN };

  // --- Single sign-on ---------------------------------------------------------------

  const oidcFields = z.object({
    enabled: z.boolean(),
    issuer: z.string().max(500),
    clientId: z.string().max(500),
    scopes: z.string().max(500),
    label: z.string().max(100),
    createUsers: z.boolean(),
    autoRedirect: z.boolean(),
    trustEmail: z.boolean(),
    groupsClaim: z.string().max(100),
  });
  const oidcOut = oidcFields.extend({ hasSecret: z.boolean() });
  const readOidc = async () => {
    const { clientSecret, ...rest } = await getOidcConfig(db);
    return { ...rest, hasSecret: clientSecret !== "" };
  };
  r.get(
    "/core/settings/oidc",
    { config, schema: { response: { 200: oidcOut } } },
    readOidc,
  );
  r.put(
    "/core/settings/oidc",
    {
      config,
      schema: {
        // A missing secret keeps the stored one.
        body: oidcFields
          .extend({ clientSecret: z.string().max(1000) })
          .partial(),
        response: { 200: oidcOut },
      },
    },
    async (req) => {
      try {
        await setOidcConfig(db, secretKey, req.body);
      } catch {
        throw new AppError(400, "validation", "Issuer must be a URL");
      }
      return readOidc();
    },
  );

  // --- Audit log ----------------------------------------------------------------------

  const eventOut = z.object({
    id: z.string(),
    type: z.string(),
    actorId: z.string().nullable(),
    entityType: z.string(),
    entityId: z.string(),
    payload: z.unknown(),
    createdAt: z.string(),
  });
  r.get(
    "/core/audit",
    {
      config,
      schema: {
        querystring: z.object({
          /** Exact type, or a prefix ending in ".*". */
          type: z.string().max(100).optional(),
          actorId: z.string().optional(),
          entityType: z.string().max(50).optional(),
          entityId: z.string().optional(),
          from: z.iso.datetime().optional(),
          to: z.iso.datetime().optional(),
          /** Id of the last event of the previous page. */
          before: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
        response: { 200: z.array(eventOut) },
      },
    },
    async (req) => {
      const f = req.query;
      let q = db.selectFrom("core_event").selectAll();
      if (f.type)
        q = f.type.endsWith(".*")
          ? q.where(
              "type",
              "like",
              `${f.type.slice(0, -1).replace(/[%_\\]/g, "")}%`,
            )
          : q.where("type", "=", f.type);
      if (f.actorId) q = q.where("actor_id", "=", f.actorId);
      if (f.entityType) q = q.where("entity_type", "=", f.entityType);
      if (f.entityId) q = q.where("entity_id", "=", f.entityId);
      if (f.from) q = q.where("created_at", ">=", new Date(f.from));
      if (f.to) q = q.where("created_at", "<", new Date(f.to));
      if (f.before) q = q.where("id", "<", f.before);
      const rows = await q.orderBy("id", "desc").limit(f.limit).execute();
      return rows.map((e) => ({
        id: e.id,
        type: e.type,
        actorId: e.actor_id,
        entityType: e.entity_type,
        entityId: e.entity_id,
        payload: JSON.parse(e.payload_json),
        createdAt: e.created_at.toISOString(),
      }));
    },
  );

  // --- Jobs ---------------------------------------------------------------------------

  const state = z.enum(["pending", "running", "done", "failed"]);
  const jobOut = z.object({
    id: z.string(),
    type: z.string(),
    state,
    attempts: z.number(),
    runAt: z.string(),
    lastError: z.string().nullable(),
    createdAt: z.string(),
  });
  r.get(
    "/core/jobs",
    {
      config,
      schema: {
        querystring: z.object({
          state: state.optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
        response: {
          200: z.object({
            counts: z.record(state, z.number()),
            jobs: z.array(jobOut),
          }),
        },
      },
    },
    async (req) => {
      const counts = await db
        .selectFrom("core_job")
        .select(["state", (eb) => eb.fn.countAll<number>().as("n")])
        .groupBy("state")
        .execute();
      let q = db.selectFrom("core_job").selectAll();
      if (req.query.state) q = q.where("state", "=", req.query.state);
      const jobs = await q
        .orderBy("created_at", "desc")
        .limit(req.query.limit)
        .execute();
      return {
        counts: Object.fromEntries(
          state.options.map((s) => [
            s,
            Number(counts.find((c) => c.state === s)?.n ?? 0),
          ]),
        ) as Record<z.infer<typeof state>, number>,
        jobs: jobs.map((j) => ({
          id: j.id,
          type: j.type,
          state: j.state,
          attempts: j.attempts,
          runAt: j.run_at.toISOString(),
          lastError: j.last_error,
          createdAt: j.created_at.toISOString(),
        })),
      };
    },
  );
  r.post(
    "/core/jobs/:id/retry",
    {
      config,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const res = await db
        .updateTable("core_job")
        .set({
          state: "pending",
          attempts: 0,
          run_at: new Date(),
          locked_by: null,
          locked_at: null,
        })
        .where("id", "=", req.params.id)
        .where("state", "=", "failed")
        .executeTakeFirst();
      if (res.numUpdatedRows === 0n)
        throw new AppError(404, "not_found", "No failed job with this id");
      return reply.status(204).send(null);
    },
  );
}
