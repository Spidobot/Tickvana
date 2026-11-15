// Queues of a service project: named saved queries with a counter, for the
// agent view. And canned responses (per project or for all projects).
import {
  AppError,
  renderText,
  requireUser,
  RichTextError,
  sanitizeDoc,
  uuidv7,
  type AppContext,
  type AuthUser,
} from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { issueTarget } from "../access.js";
import type { TrackContext } from "../context.js";

/** Rows a queue counts at most; the agent view shows "1000+" beyond. */
const CAP = 1000;

export async function queueRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
  app: AppContext,
): Promise<void> {
  const { db, access } = ctx;
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const custom = { permission: "custom" as const };
  const keyParam = z.object({ key: z.string().max(10) });
  const idParam = z.object({ id: z.string() });

  /** Keys of the tickets a queue's query returns, as the user sees them. */
  async function keysOf(user: AuthUser, queryId: string, projectId: string) {
    const result = await app.savedQueries
      .run(user, queryId, { limit: CAP })
      .catch(() => null);
    if (!result) return null;
    const ids = result.rows
      .map((row) => row.id ?? row.issue_key)
      .filter((v): v is string => typeof v === "string");
    if (!ids.length) return [];
    // The query may name tickets by id or by key; keep this project's, in the query's order.
    const rows = await db
      .selectFrom("track_issue")
      .select(["id", "key"])
      .where("project_id", "=", projectId)
      .where((eb) => eb.or([eb("id", "in", ids), eb("key", "in", ids)]))
      .execute();
    const byAny = new Map(
      rows.flatMap(
        (x) =>
          [
            [x.id, x.key],
            [x.key, x.key],
          ] as const,
      ),
    );
    return [
      ...new Set(ids.map((v) => byAny.get(v)).filter((k): k is string => !!k)),
    ];
  }

  const queueOut = z.object({
    id: z.string(),
    name: z.string(),
    queryId: z.string(),
    position: z.number(),
    /** null when the query cannot run for this user. */
    count: z.number().nullable(),
  });

  r.get(
    "/projects/:key/queues",
    {
      config: custom,
      schema: { params: keyParam, response: { 200: z.array(queueOut) } },
    },
    async (req) => {
      const user = requireUser(req);
      const project = await ctx.project(user, req.params.key, "issue.edit");
      const queues = await db
        .selectFrom("track_queue")
        .selectAll()
        .where("project_id", "=", project.id)
        .orderBy("position")
        .execute();
      return Promise.all(
        queues.map(async (q) => ({
          id: q.id,
          name: q.name,
          queryId: q.query_id,
          position: q.position,
          count: (await keysOf(user, q.query_id, project.id))?.length ?? null,
        })),
      );
    },
  );

  const queueBody = z.object({
    name: z.string().trim().min(1).max(200),
    queryId: z.string(),
    position: z.number().int().min(0).optional(),
  });

  r.post(
    "/projects/:key/queues",
    {
      config: custom,
      schema: {
        params: keyParam,
        body: queueBody,
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const project = await ctx.project(
        user,
        req.params.key,
        "project.administer",
      );
      // The query must be one the administrator may use.
      await app.savedQueries.load(user, req.body.queryId);
      const last = await db
        .selectFrom("track_queue")
        .select("position")
        .where("project_id", "=", project.id)
        .orderBy("position", "desc")
        .executeTakeFirst();
      const id = uuidv7();
      await db
        .insertInto("track_queue")
        .values({
          id,
          project_id: project.id,
          name: req.body.name,
          query_id: req.body.queryId,
          position: req.body.position ?? (last?.position ?? -1) + 1,
        })
        .execute();
      return reply.status(201).send({ id });
    },
  );

  async function loadQueue(
    user: AuthUser,
    id: string,
    permission: "issue.edit" | "project.administer",
  ) {
    const q = await db
      .selectFrom("track_queue as q")
      .innerJoin("track_project as p", "p.id", "q.project_id")
      .selectAll("q")
      .select("p.key as project_key")
      .where("q.id", "=", id)
      .executeTakeFirst();
    if (!q) throw new AppError(404, "not_found", "Not found");
    await ctx.project(user, q.project_key, permission);
    return q;
  }

  r.put(
    "/queues/:id",
    {
      config: custom,
      schema: { params: idParam, body: queueBody, response: { 204: z.null() } },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const q = await loadQueue(user, req.params.id, "project.administer");
      await app.savedQueries.load(user, req.body.queryId);
      await db
        .updateTable("track_queue")
        .set({
          name: req.body.name,
          query_id: req.body.queryId,
          position: req.body.position ?? q.position,
        })
        .where("id", "=", q.id)
        .execute();
      return reply.status(204).send(null);
    },
  );

  r.delete(
    "/queues/:id",
    { config: custom, schema: { params: idParam } },
    async (req, reply) => {
      const q = await loadQueue(
        requireUser(req),
        req.params.id,
        "project.administer",
      );
      await db.deleteFrom("track_queue").where("id", "=", q.id).execute();
      return reply.status(204).send(null);
    },
  );

  r.get(
    "/queues/:id/issues",
    {
      config: custom,
      schema: {
        params: idParam,
        response: {
          200: z.array(
            z.object({
              key: z.string(),
              summary: z.string(),
              statusId: z.string(),
              priorityId: z.string(),
              assigneeId: z.string().nullable(),
              reporterId: z.string(),
              updatedAt: z.string(),
              /** Earliest due time of a running SLA clock. */
              slaDueAt: z.string().nullable(),
              /** Whether any SLA clock of the ticket is breached. */
              slaBreached: z.boolean(),
            }),
          ),
        },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const q = await loadQueue(user, req.params.id, "issue.edit");
      const keys = (await keysOf(user, q.query_id, q.project_id)) ?? [];
      // ponytail: the first 200 tickets of a queue; agents work from the top.
      const shown = keys.slice(0, 200);
      if (!shown.length) return [];
      const rows = await db
        .selectFrom("track_issue")
        .selectAll()
        .where("key", "in", shown)
        .execute();
      const clocks = rows.length
        ? await db
            .selectFrom("track_sla_cycle")
            .select([
              "issue_id",
              "due_at",
              "breached",
              "stopped_at",
              "paused_at",
            ])
            .where(
              "issue_id",
              "in",
              rows.map((x) => x.id),
            )
            .execute()
        : [];
      const slaOf = (issueId: string) => {
        const mine = clocks.filter((c) => c.issue_id === issueId);
        const due = mine
          .filter((c) => !c.stopped_at && !c.paused_at)
          .map((c) => c.due_at.getTime())
          .sort((a, b) => a - b)[0];
        return {
          slaDueAt: due === undefined ? null : new Date(due).toISOString(),
          slaBreached: mine.some((c) => Boolean(c.breached)),
        };
      };
      const visible = [];
      for (const key of shown) {
        const row = rows.find((x) => x.key === key);
        if (row && (await access.can(user, "project.browse", issueTarget(row))))
          visible.push({
            key: row.key,
            summary: row.summary,
            statusId: row.status_id,
            priorityId: row.priority_id,
            assigneeId: row.assignee_id,
            reporterId: row.reporter_id,
            updatedAt: row.updated_at.toISOString(),
            ...slaOf(row.id),
          });
      }
      return visible;
    },
  );

  // --- Canned responses -------------------------------------------------------------

  const cannedOut = z.object({
    id: z.string(),
    projectKey: z.string().nullable(),
    name: z.string(),
    body: z.unknown(),
  });
  const docOf = (value: unknown) => {
    try {
      const doc = sanitizeDoc(value);
      if (!renderText(doc).trim())
        throw new AppError(400, "validation", "The text is empty");
      return JSON.stringify(doc);
    } catch (e) {
      throw e instanceof RichTextError
        ? new AppError(400, "validation", e.message)
        : e;
    }
  };

  r.get(
    "/projects/:key/canned-responses",
    {
      config: custom,
      schema: { params: keyParam, response: { 200: z.array(cannedOut) } },
    },
    async (req) => {
      const project = await ctx.project(
        requireUser(req),
        req.params.key,
        "issue.comment",
      );
      const rows = await db
        .selectFrom("track_canned_response")
        .selectAll()
        .where((eb) =>
          eb.or([
            eb("project_id", "=", project.id),
            eb("project_id", "is", null),
          ]),
        )
        .orderBy("name")
        .execute();
      return rows.map((x) => ({
        id: x.id,
        projectKey: x.project_id ? project.key : null,
        name: x.name,
        body: JSON.parse(x.body_json),
      }));
    },
  );

  r.post(
    "/projects/:key/canned-responses",
    {
      config: custom,
      schema: {
        params: keyParam,
        body: z.object({
          name: z.string().trim().min(1).max(200),
          body: z.unknown(),
        }),
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    async (req, reply) => {
      const project = await ctx.project(
        requireUser(req),
        req.params.key,
        "project.administer",
      );
      const id = uuidv7();
      await db
        .insertInto("track_canned_response")
        .values({
          id,
          project_id: project.id,
          name: req.body.name,
          body_json: docOf(req.body.body),
        })
        .execute();
      return reply.status(201).send({ id });
    },
  );

  r.delete(
    "/canned-responses/:id",
    { config: custom, schema: { params: idParam } },
    async (req, reply) => {
      const row = await db
        .selectFrom("track_canned_response as c")
        .leftJoin("track_project as p", "p.id", "c.project_id")
        .select(["c.id", "p.key"])
        .where("c.id", "=", req.params.id)
        .executeTakeFirst();
      if (!row) throw new AppError(404, "not_found", "Not found");
      const user = requireUser(req);
      if (row.key) await ctx.project(user, row.key, "project.administer");
      else await ctx.permissions.require(user, "system.admin");
      await db
        .deleteFrom("track_canned_response")
        .where("id", "=", row.id)
        .execute();
      return reply.status(204).send(null);
    },
  );
}
