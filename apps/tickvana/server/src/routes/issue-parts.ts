// What hangs on a ticket besides its fields: comments, work logs, watchers,
// votes, links and children. Plus the project's components and versions.
import {
  AppError,
  renderText,
  requireUser,
  RichTextError,
  sanitizeDoc,
  uuidv7,
  type AuthUser,
} from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { issueTarget } from "../access.js";
import type { TrackContext } from "../context.js";
import type { TrackDb } from "../db/schema.js";
import type { IssueService } from "../issues.js";

const keyParam = z.object({ key: z.string().max(30) });
const idParam = z.object({ id: z.string() });
const notFound = () => new AppError(404, "not_found", "Not found");
const forbidden = () =>
  new AppError(403, "forbidden", "You do not have permission to do this");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const touch = (trx: TrackContext["db"], issueId: string, now: Date) =>
  trx
    .updateTable("track_issue")
    .set({ updated_at: now })
    .where("id", "=", issueId)
    .execute();
const docOf = (value: unknown) => {
  try {
    const doc = sanitizeDoc(value);
    const text = renderText(doc);
    if (!text.trim() && !JSON.stringify(doc).includes('"image"'))
      throw new AppError(400, "validation", "Comment is empty");
    return { json: JSON.stringify(doc), text };
  } catch (e) {
    throw e instanceof RichTextError
      ? new AppError(400, "validation", e.message)
      : e;
  }
};

/** Adds a comment as `user`, with the same checks as the API. Automations use it too. */
export async function addComment(
  ctx: TrackContext,
  issues: IssueService,
  user: AuthUser,
  key: string,
  value: unknown,
  visibility: "public" | "internal",
): Promise<TrackDb["track_comment"]> {
  const issue = await issues.load(user, key, "issue.comment");
  if (visibility === "internal")
    await ctx.access.require(user, "comment.internal", issueTarget(issue));
  const body = docOf(value);
  const now = new Date();
  const comment: TrackDb["track_comment"] = {
    id: uuidv7(),
    issue_id: issue.id,
    author_id: user.id,
    body_json: body.json,
    body_text: body.text,
    visibility,
    created_at: now,
    updated_at: now,
  };
  await ctx.db.transaction().execute(async (trx) => {
    // Ticket row first, see the note where work is logged.
    await touch(trx, issue.id, now);
    await trx.insertInto("track_comment").values(comment).execute();
    await ctx.emit(trx, {
      type: "issue.commented",
      actorId: user.id,
      entityType: "issue",
      entityId: issue.id,
      payload: {
        key: issue.key,
        commentId: comment.id,
        visibility: comment.visibility,
      },
    });
  });
  return comment;
}

export async function issuePartRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
  issues: IssueService,
): Promise<void> {
  const { db, access } = ctx;
  const r = scope.withTypeProvider<ZodTypeProvider>();
  // Every handler loads the ticket or project through a helper that checks access.
  const custom = { permission: "custom" as const };

  /** Authors change their own entries, project administrators anyone's. */
  const ownOrAdmin = async (
    user: AuthUser,
    authorId: string,
    issue: TrackDb["track_issue"],
  ) => {
    if (
      user.id !== authorId &&
      !(await access.can(user, "project.administer", issueTarget(issue)))
    )
      throw forbidden();
  };
  const issueById = async (user: AuthUser | null, id: string) => {
    const row = await db
      .selectFrom("track_issue")
      .select("key")
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) throw notFound();
    return issues.load(user, row.key);
  };

  // --- Comments ---------------------------------------------------------------------

  const commentSchema = z.object({
    id: z.string(),
    authorId: z.string(),
    body: z.unknown(),
    visibility: z.enum(["public", "internal"]),
    createdAt: z.string(),
    updatedAt: z.string(),
  });
  const toComment = (
    c: TrackDb["track_comment"],
  ): z.infer<typeof commentSchema> => ({
    id: c.id,
    authorId: c.author_id,
    body: JSON.parse(c.body_json),
    visibility: c.visibility,
    createdAt: c.created_at.toISOString(),
    updatedAt: c.updated_at.toISOString(),
  });

  r.get(
    "/issues/:key/comments",
    {
      config: { ...custom, customers: true },
      schema: { params: keyParam, response: { 200: z.array(commentSchema) } },
    },
    async (req) => {
      const issue = await issues.load(req.user, req.params.key);
      const seesInternal = await access.can(
        req.user,
        "comment.internal",
        issueTarget(issue),
      );
      let query = db
        .selectFrom("track_comment")
        .selectAll()
        .where("issue_id", "=", issue.id);
      if (!seesInternal) query = query.where("visibility", "=", "public");
      return (await query.orderBy("id").execute()).map(toComment);
    },
  );

  r.post(
    "/issues/:key/comments",
    {
      config: { ...custom, customers: true },
      schema: {
        params: keyParam,
        body: z.object({
          body: z.unknown(),
          visibility: z.enum(["public", "internal"]).default("public"),
        }),
        response: { 201: commentSchema },
      },
    },
    async (req, reply) => {
      const comment = await addComment(
        ctx,
        issues,
        requireUser(req),
        req.params.key,
        req.body.body,
        req.body.visibility,
      );
      return reply.status(201).send(toComment(comment));
    },
  );

  const loadComment = async (user: AuthUser, id: string) => {
    const comment = await db
      .selectFrom("track_comment")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!comment) throw notFound();
    const issue = await issueById(user, comment.issue_id);
    if (
      comment.visibility === "internal" &&
      !(await access.can(user, "comment.internal", issueTarget(issue)))
    )
      throw notFound();
    await ownOrAdmin(user, comment.author_id, issue);
    return comment;
  };

  r.patch(
    "/comments/:id",
    {
      config: custom,
      schema: {
        params: idParam,
        body: z.object({ body: z.unknown() }),
        response: { 200: commentSchema },
      },
    },
    async (req) => {
      const comment = await loadComment(requireUser(req), req.params.id);
      const body = docOf(req.body.body);
      const now = new Date();
      await db
        .updateTable("track_comment")
        .set({ body_json: body.json, body_text: body.text, updated_at: now })
        .where("id", "=", comment.id)
        .execute();
      return toComment({
        ...comment,
        body_json: body.json,
        body_text: body.text,
        updated_at: now,
      });
    },
  );

  r.delete(
    "/comments/:id",
    {
      config: custom,
      schema: { params: idParam, response: { 204: z.null() } },
    },
    async (req, reply) => {
      const comment = await loadComment(requireUser(req), req.params.id);
      await db
        .deleteFrom("track_comment")
        .where("id", "=", comment.id)
        .execute();
      return reply.status(204).send(null);
    },
  );

  // --- Work logs --------------------------------------------------------------------

  const worklogSchema = z.object({
    id: z.string(),
    authorId: z.string(),
    startedAt: z.string(),
    seconds: z.number(),
    note: z.string(),
  });
  const toWorklog = (
    w: TrackDb["track_worklog"],
  ): z.infer<typeof worklogSchema> => ({
    id: w.id,
    authorId: w.author_id,
    startedAt: w.started_at.toISOString(),
    seconds: w.seconds,
    note: w.note,
  });

  r.get(
    "/issues/:key/worklogs",
    {
      config: custom,
      schema: { params: keyParam, response: { 200: z.array(worklogSchema) } },
    },
    async (req) => {
      const issue = await issues.load(req.user, req.params.key);
      return (
        await db
          .selectFrom("track_worklog")
          .selectAll()
          .where("issue_id", "=", issue.id)
          .orderBy("started_at")
          .execute()
      ).map(toWorklog);
    },
  );

  r.post(
    "/issues/:key/worklogs",
    {
      config: custom,
      schema: {
        params: keyParam,
        body: z.object({
          seconds: z
            .number()
            .int()
            .min(60)
            .max(7 * 24 * 3600),
          startedAt: z.iso.datetime().optional(),
          note: z.string().max(2000).default(""),
          /** "auto" subtracts the logged time, "keep" leaves it, a number sets it. */
          remaining: z
            .union([
              z.literal("auto"),
              z.literal("keep"),
              z.number().int().min(0),
            ])
            .default("auto"),
        }),
        response: { 201: worklogSchema },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const issue = await issues.load(user, req.params.key, "issue.worklog");
      const now = new Date();
      const log: TrackDb["track_worklog"] = {
        id: uuidv7(),
        issue_id: issue.id,
        author_id: user.id,
        started_at: req.body.startedAt ? new Date(req.body.startedAt) : now,
        seconds: req.body.seconds,
        note: req.body.note,
        created_at: now,
      };
      const { remaining } = req.body;
      await db.transaction().execute(async (trx) => {
        // The ticket row first: this takes its write lock, so people logging at
        // the same moment queue up. Inserting the child row first would give
        // each a shared lock through the foreign key and deadlock on MariaDB.
        // The sum is added in SQL, not from the value read above.
        await trx
          .updateTable("track_issue")
          .set((eb) => ({
            spent_sec: eb("spent_sec", "+", log.seconds),
            updated_at: now,
          }))
          .where("id", "=", issue.id)
          .execute();
        await trx.insertInto("track_worklog").values(log).execute();
        if (remaining !== "keep") {
          const current = await trx
            .selectFrom("track_issue")
            .select("remaining_sec")
            .where("id", "=", issue.id)
            .executeTakeFirstOrThrow();
          const next =
            remaining === "auto"
              ? current.remaining_sec === null
                ? null
                : Math.max(0, current.remaining_sec - log.seconds)
              : remaining;
          await trx
            .updateTable("track_issue")
            .set({ remaining_sec: next })
            .where("id", "=", issue.id)
            .execute();
        }
        await ctx.emit(trx, {
          type: "issue.worklogged",
          actorId: user.id,
          entityType: "issue",
          entityId: issue.id,
          payload: { key: issue.key, seconds: log.seconds },
        });
      });
      return reply.status(201).send(toWorklog(log));
    },
  );

  r.delete(
    "/worklogs/:id",
    {
      config: custom,
      schema: { params: idParam, response: { 204: z.null() } },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const log = await db
        .selectFrom("track_worklog")
        .selectAll()
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (!log) throw notFound();
      const issue = await issueById(user, log.issue_id);
      await ownOrAdmin(user, log.author_id, issue);
      await db.transaction().execute(async (trx) => {
        // Ticket row first, see the note where work is logged.
        await trx
          .updateTable("track_issue")
          .set((eb) => ({
            spent_sec: eb("spent_sec", "-", log.seconds),
            updated_at: new Date(),
          }))
          .where("id", "=", issue.id)
          .execute();
        await trx
          .deleteFrom("track_worklog")
          .where("id", "=", log.id)
          .execute();
      });
      return reply.status(204).send(null);
    },
  );

  // --- Watchers and votes ----------------------------------------------------------

  r.get(
    "/issues/:key/watchers",
    {
      config: custom,
      schema: { params: keyParam, response: { 200: z.array(z.string()) } },
    },
    async (req) => {
      const issue = await issues.load(req.user, req.params.key);
      return (
        await db
          .selectFrom("track_watcher")
          .select("user_id")
          .where("issue_id", "=", issue.id)
          .orderBy("user_id")
          .execute()
      ).map((w) => w.user_id);
    },
  );

  const watcherParams = keyParam.extend({ userId: z.string() });
  /** People add and remove themselves. Putting someone else on the list needs issue.edit. */
  const watcherTarget = async (req: {
    user: AuthUser | null;
    params: { key: string; userId: string };
  }) => {
    const user = requireUser(req as never);
    const issue = await issues.load(user, req.params.key);
    if (req.params.userId !== user.id)
      await access.require(user, "issue.edit", issueTarget(issue));
    return issue;
  };

  r.put(
    "/issues/:key/watchers/:userId",
    {
      config: custom,
      schema: { params: watcherParams, response: { 204: z.null() } },
    },
    async (req, reply) => {
      const issue = await watcherTarget(req);
      const watcher = await db
        .selectFrom("core_user")
        .select(["id", "kind", "locale", "timezone", "email", "display_name"])
        .where("id", "=", req.params.userId)
        .where("active", "=", true)
        .executeTakeFirst();
      // A watcher gets mail about the ticket, so they must be allowed to see it.
      const sees =
        watcher &&
        (await access.can(
          {
            id: watcher.id,
            kind: watcher.kind,
            email: watcher.email,
            displayName: watcher.display_name,
            locale: watcher.locale,
            timezone: watcher.timezone,
          },
          "project.browse",
          issueTarget(issue),
        ));
      if (!sees)
        throw new AppError(
          400,
          "validation",
          "Watcher must be an active user who may see the ticket",
        );
      await db.transaction().execute(async (trx) => {
        const row = { issue_id: issue.id, user_id: req.params.userId };
        const exists = await trx
          .selectFrom("track_watcher")
          .select("user_id")
          .where("issue_id", "=", row.issue_id)
          .where("user_id", "=", row.user_id)
          .executeTakeFirst();
        if (!exists)
          await trx.insertInto("track_watcher").values(row).execute();
      });
      return reply.status(204).send(null);
    },
  );

  r.delete(
    "/issues/:key/watchers/:userId",
    {
      config: custom,
      schema: { params: watcherParams, response: { 204: z.null() } },
    },
    async (req, reply) => {
      const issue = await watcherTarget(req);
      await db
        .deleteFrom("track_watcher")
        .where("issue_id", "=", issue.id)
        .where("user_id", "=", req.params.userId)
        .execute();
      return reply.status(204).send(null);
    },
  );

  const voteSchema = z.object({ count: z.number(), voted: z.boolean() });
  const votes = async (issueId: string, userId: string | undefined) => {
    const rows = await db
      .selectFrom("track_vote")
      .select("user_id")
      .where("issue_id", "=", issueId)
      .execute();
    return {
      count: rows.length,
      voted: rows.some((v) => v.user_id === userId),
    };
  };

  r.get(
    "/issues/:key/votes",
    {
      config: custom,
      schema: { params: keyParam, response: { 200: voteSchema } },
    },
    async (req) =>
      votes((await issues.load(req.user, req.params.key)).id, req.user?.id),
  );

  r.put(
    "/issues/:key/votes",
    {
      config: custom,
      schema: { params: keyParam, response: { 200: voteSchema } },
    },
    async (req) => {
      const user = requireUser(req);
      const issue = await issues.load(user, req.params.key);
      if (issue.reporter_id === user.id)
        throw new AppError(
          409,
          "conflict",
          "You cannot vote for a ticket you reported",
        );
      await db.transaction().execute(async (trx) => {
        const exists = await trx
          .selectFrom("track_vote")
          .select("user_id")
          .where("issue_id", "=", issue.id)
          .where("user_id", "=", user.id)
          .executeTakeFirst();
        if (!exists)
          await trx
            .insertInto("track_vote")
            .values({ issue_id: issue.id, user_id: user.id })
            .execute();
      });
      return votes(issue.id, user.id);
    },
  );

  r.delete(
    "/issues/:key/votes",
    {
      config: custom,
      schema: { params: keyParam, response: { 200: voteSchema } },
    },
    async (req) => {
      const user = requireUser(req);
      const issue = await issues.load(user, req.params.key);
      await db
        .deleteFrom("track_vote")
        .where("issue_id", "=", issue.id)
        .where("user_id", "=", user.id)
        .execute();
      return votes(issue.id, user.id);
    },
  );

  // --- Links and children ------------------------------------------------------------

  r.get(
    "/link-types",
    {
      config: { permission: "authenticated" as const },
      schema: {
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              outward: z.string(),
              inward: z.string(),
            }),
          ),
        },
      },
    },
    () =>
      db.selectFrom("track_link_type").selectAll().orderBy("name").execute(),
  );

  const linkSchema = z.object({
    id: z.string(),
    typeId: z.string(),
    relation: z.string(),
    direction: z.enum(["outward", "inward"]),
    issue: z.object({
      id: z.string(),
      key: z.string(),
      summary: z.string(),
      statusId: z.string(),
    }),
  });

  r.get(
    "/issues/:key/links",
    {
      config: custom,
      schema: { params: keyParam, response: { 200: z.array(linkSchema) } },
    },
    async (req) => {
      const issue = await issues.load(req.user, req.params.key);
      const rows = await db
        .selectFrom("track_issue_link as l")
        .innerJoin("track_link_type as t", "t.id", "l.type_id")
        .select([
          "l.id",
          "l.type_id",
          "l.from_issue_id",
          "l.to_issue_id",
          "t.outward",
          "t.inward",
        ])
        .where((eb) =>
          eb.or([
            eb("l.from_issue_id", "=", issue.id),
            eb("l.to_issue_id", "=", issue.id),
          ]),
        )
        .orderBy("l.id")
        .execute();
      const out: z.infer<typeof linkSchema>[] = [];
      for (const l of rows) {
        const outward = l.from_issue_id === issue.id;
        const other = await db
          .selectFrom("track_issue")
          .selectAll()
          .where("id", "=", outward ? l.to_issue_id : l.from_issue_id)
          .executeTakeFirstOrThrow();
        // Links to tickets the user may not see are left out, not shown as stubs.
        if (!(await access.can(req.user, "project.browse", issueTarget(other))))
          continue;
        out.push({
          id: l.id,
          typeId: l.type_id,
          relation: outward ? l.outward : l.inward,
          direction: outward ? "outward" : "inward",
          issue: {
            id: other.id,
            key: other.key,
            summary: other.summary,
            statusId: other.status_id,
          },
        });
      }
      return out;
    },
  );

  r.post(
    "/issues/:key/links",
    {
      config: custom,
      schema: {
        params: keyParam,
        body: z.object({ typeId: z.string(), toKey: z.string().max(30) }),
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const from = await issues.load(user, req.params.key, "issue.edit");
      const to = await issues.load(user, req.body.toKey);
      if (from.id === to.id)
        throw new AppError(400, "validation", "A ticket cannot link to itself");
      const type = await db
        .selectFrom("track_link_type")
        .select("id")
        .where("id", "=", req.body.typeId)
        .executeTakeFirst();
      if (!type) throw new AppError(400, "validation", "Unknown link type");
      const id = uuidv7();
      await db.transaction().execute(async (trx) => {
        const exists = await trx
          .selectFrom("track_issue_link")
          .select("id")
          .where("type_id", "=", type.id)
          .where("from_issue_id", "=", from.id)
          .where("to_issue_id", "=", to.id)
          .executeTakeFirst();
        if (exists)
          throw new AppError(409, "conflict", "This link already exists");
        await trx
          .insertInto("track_issue_link")
          .values({
            id,
            type_id: type.id,
            from_issue_id: from.id,
            to_issue_id: to.id,
          })
          .execute();
        await ctx.emit(trx, {
          type: "issue.linked",
          actorId: user.id,
          entityType: "issue",
          entityId: from.id,
          payload: { key: from.key, to: to.key },
        });
      });
      return reply.status(201).send({ id });
    },
  );

  r.delete(
    "/links/:id",
    {
      config: custom,
      schema: { params: idParam, response: { 204: z.null() } },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const link = await db
        .selectFrom("track_issue_link")
        .selectAll()
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (!link) throw notFound();
      const from = await issueById(user, link.from_issue_id);
      await access.require(user, "issue.edit", issueTarget(from));
      await db
        .deleteFrom("track_issue_link")
        .where("id", "=", link.id)
        .execute();
      return reply.status(204).send(null);
    },
  );

  r.get(
    "/issues/:key/children",
    {
      config: custom,
      schema: {
        params: keyParam,
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              key: z.string(),
              summary: z.string(),
              typeId: z.string(),
              statusId: z.string(),
              assigneeId: z.string().nullable(),
            }),
          ),
        },
      },
    },
    async (req) => {
      const issue = await issues.load(req.user, req.params.key);
      const rows = await db
        .selectFrom("track_issue")
        .selectAll()
        .where("parent_id", "=", issue.id)
        .orderBy("rank")
        .execute();
      const out = [];
      for (const c of rows) {
        if (
          c.security_level_id &&
          !(await access.can(req.user, "project.browse", issueTarget(c)))
        )
          continue;
        out.push({
          id: c.id,
          key: c.key,
          summary: c.summary,
          typeId: c.type_id,
          statusId: c.status_id,
          assigneeId: c.assignee_id,
        });
      }
      return out;
    },
  );

  // --- Components and versions of a project ------------------------------------------

  const projectKey = z.object({ key: z.string().max(10) });
  const componentSchema = z.object({
    id: z.string(),
    name: z.string(),
    leadId: z.string().nullable(),
  });
  const componentBody = z.object({
    name: z.string().trim().min(1).max(200),
    leadId: z.string().nullable().default(null),
  });
  const versionSchema = z.object({
    id: z.string(),
    name: z.string(),
    startDate: date.nullable(),
    releaseDate: date.nullable(),
    released: z.boolean(),
  });
  const toVersion = (
    v: TrackDb["track_version"],
  ): z.infer<typeof versionSchema> => ({
    id: v.id,
    name: v.name,
    startDate: v.start_date,
    releaseDate: v.release_date,
    released: v.released,
  });

  r.get(
    "/projects/:key/components",
    {
      config: custom,
      schema: {
        params: projectKey,
        response: { 200: z.array(componentSchema) },
      },
    },
    async (req) => {
      const project = await ctx.project(req.user, req.params.key);
      return (
        await db
          .selectFrom("track_component")
          .selectAll()
          .where("project_id", "=", project.id)
          .orderBy("name")
          .execute()
      ).map((c) => ({ id: c.id, name: c.name, leadId: c.lead_id }));
    },
  );

  r.post(
    "/projects/:key/components",
    {
      config: custom,
      schema: {
        params: projectKey,
        body: componentBody,
        response: { 201: componentSchema },
      },
    },
    async (req, reply) => {
      const project = await ctx.project(
        req.user,
        req.params.key,
        "project.administer",
      );
      const taken = await db
        .selectFrom("track_component")
        .select("id")
        .where("project_id", "=", project.id)
        .where("name", "=", req.body.name)
        .executeTakeFirst();
      if (taken)
        throw new AppError(
          409,
          "conflict",
          `Component "${req.body.name}" already exists`,
        );
      const id = uuidv7();
      await db
        .insertInto("track_component")
        .values({
          id,
          project_id: project.id,
          name: req.body.name,
          lead_id: req.body.leadId,
        })
        .execute();
      return reply
        .status(201)
        .send({ id, name: req.body.name, leadId: req.body.leadId });
    },
  );

  /** Loads a component or version and checks that the user administers its project. */
  const owned = async <T extends "track_component" | "track_version">(
    table: T,
    id: string,
    user: AuthUser | null,
  ) => {
    const row = await (
      db.selectFrom(table) as ReturnType<
        typeof db.selectFrom<"track_component">
      >
    )
      .select(["id", "project_id"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) throw notFound();
    const project = await db
      .selectFrom("track_project")
      .select("key")
      .where("id", "=", row.project_id)
      .executeTakeFirstOrThrow();
    await ctx.project(user, project.key, "project.administer");
    return row;
  };

  r.patch(
    "/components/:id",
    {
      config: custom,
      schema: {
        params: idParam,
        body: componentBody.partial(),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await owned("track_component", req.params.id, req.user);
      const { name, leadId } = req.body;
      if (name !== undefined || leadId !== undefined) {
        await db
          .updateTable("track_component")
          .set({
            ...(name !== undefined && { name }),
            ...(leadId !== undefined && { lead_id: leadId }),
          })
          .where("id", "=", req.params.id)
          .execute();
      }
      return reply.status(204).send(null);
    },
  );

  r.delete(
    "/components/:id",
    {
      config: custom,
      schema: { params: idParam, response: { 204: z.null() } },
    },
    async (req, reply) => {
      await owned("track_component", req.params.id, req.user);
      // Tickets simply lose the component (cascade on the link table).
      await db
        .deleteFrom("track_component")
        .where("id", "=", req.params.id)
        .execute();
      return reply.status(204).send(null);
    },
  );

  const versionBody = z.object({
    name: z.string().trim().min(1).max(200),
    startDate: date.nullable(),
    releaseDate: date.nullable(),
    released: z.boolean(),
  });

  r.get(
    "/projects/:key/versions",
    {
      config: custom,
      schema: { params: projectKey, response: { 200: z.array(versionSchema) } },
    },
    async (req) => {
      const project = await ctx.project(req.user, req.params.key);
      return (
        await db
          .selectFrom("track_version")
          .selectAll()
          .where("project_id", "=", project.id)
          .orderBy("name")
          .execute()
      ).map(toVersion);
    },
  );

  /** Per fix version: how many tickets it holds and how many are done. Only tickets the viewer may see count. */
  r.get(
    "/projects/:key/versions/progress",
    {
      config: custom,
      schema: {
        params: projectKey,
        response: {
          200: z.array(
            z.object({
              versionId: z.string(),
              total: z.number(),
              done: z.number(),
            }),
          ),
        },
      },
    },
    async (req) => {
      const project = await ctx.project(req.user, req.params.key);
      const rows = await db
        .selectFrom("track_issue_version as iv")
        .innerJoin("track_issue as i", "i.id", "iv.issue_id")
        .innerJoin("track_status as s", "s.id", "i.status_id")
        .selectAll("i")
        .select(["iv.version_id", "s.category"])
        .where("i.project_id", "=", project.id)
        .where("iv.kind", "=", "fix")
        .execute();
      const counts = new Map<string, { total: number; done: number }>();
      for (const row of rows) {
        if (
          row.security_level_id &&
          !(await access.can(req.user, "project.browse", issueTarget(row)))
        )
          continue;
        const c = counts.get(row.version_id) ?? { total: 0, done: 0 };
        c.total++;
        if (row.category === "done") c.done++;
        counts.set(row.version_id, c);
      }
      return [...counts].map(([versionId, c]) => ({ versionId, ...c }));
    },
  );

  r.post(
    "/projects/:key/versions",
    {
      config: custom,
      schema: {
        params: projectKey,
        body: versionBody.partial().required({ name: true }),
        response: { 201: versionSchema },
      },
    },
    async (req, reply) => {
      const project = await ctx.project(
        req.user,
        req.params.key,
        "project.administer",
      );
      const taken = await db
        .selectFrom("track_version")
        .select("id")
        .where("project_id", "=", project.id)
        .where("name", "=", req.body.name)
        .executeTakeFirst();
      if (taken)
        throw new AppError(
          409,
          "conflict",
          `Version "${req.body.name}" already exists`,
        );
      const version: TrackDb["track_version"] = {
        id: uuidv7(),
        project_id: project.id,
        name: req.body.name,
        start_date: req.body.startDate ?? null,
        release_date: req.body.releaseDate ?? null,
        released: req.body.released ?? false,
      };
      await db.insertInto("track_version").values(version).execute();
      return reply.status(201).send(toVersion(version));
    },
  );

  r.patch(
    "/versions/:id",
    {
      config: custom,
      schema: {
        params: idParam,
        body: versionBody.partial(),
        response: { 200: versionSchema },
      },
    },
    async (req) => {
      await owned("track_version", req.params.id, req.user);
      const { name, startDate, releaseDate, released } = req.body;
      const set = {
        ...(name !== undefined && { name }),
        ...(startDate !== undefined && { start_date: startDate }),
        ...(releaseDate !== undefined && { release_date: releaseDate }),
        ...(released !== undefined && { released }),
      };
      if (Object.keys(set).length)
        await db
          .updateTable("track_version")
          .set(set)
          .where("id", "=", req.params.id)
          .execute();
      return toVersion(
        await db
          .selectFrom("track_version")
          .selectAll()
          .where("id", "=", req.params.id)
          .executeTakeFirstOrThrow(),
      );
    },
  );

  r.delete(
    "/versions/:id",
    {
      config: custom,
      schema: { params: idParam, response: { 204: z.null() } },
    },
    async (req, reply) => {
      await owned("track_version", req.params.id, req.user);
      await db
        .deleteFrom("track_version")
        .where("id", "=", req.params.id)
        .execute();
      return reply.status(204).send(null);
    },
  );
}
