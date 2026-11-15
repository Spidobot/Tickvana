// Sprints of a scrum board and the backlog beside them. A ticket is in at
// most one open (future or active) sprint; a closed sprint keeps its tickets
// as history, with removed_at set for those carried over.
import {
  AppError,
  requireUser,
  uuidv7,
  type AppContext,
  type AuthUser,
} from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { issueTarget } from "../access.js";
import type { TrackContext } from "../context.js";
import type { TrackDb } from "../db/schema.js";
import type { IssueService } from "../issues.js";

type Sprint = TrackDb["track_sprint"];

const sprintSchema = z.object({
  id: z.string(),
  name: z.string(),
  goal: z.string(),
  state: z.enum(["future", "active", "closed"]),
  startAt: z.string().nullable(),
  endAt: z.string().nullable(),
});
const toSprint = (s: Sprint): z.infer<typeof sprintSchema> => ({
  id: s.id,
  name: s.name,
  goal: s.goal,
  state: s.state,
  startAt: s.start_at?.toISOString() ?? null,
  endAt: s.end_at?.toISOString() ?? null,
});
const entry = z.object({
  key: z.string(),
  summary: z.string(),
  statusId: z.string(),
  assigneeId: z.string().nullable(),
  estimateSec: z.number().nullable(),
  done: z.boolean(),
  /** Id of the parent ticket, e.g. the epic. */
  parentId: z.string().nullable(),
});

export async function sprintRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
  app: AppContext,
  issues: IssueService,
): Promise<void> {
  const { db, access } = ctx;
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const custom = { permission: "custom" as const };
  const idParam = z.object({ id: z.string() });

  /** A board the user may see; planning needs edit rights in the board's project. */
  async function board(user: AuthUser, id: string, plan = false) {
    const b = await db
      .selectFrom("track_board")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!b) throw new AppError(404, "not_found", "Not found");
    await app.savedQueries.load(user, b.query_id);
    if (b.kind !== "scrum")
      throw new AppError(409, "conflict", "Only scrum boards have sprints");
    if (
      plan &&
      !(
        b.project_id &&
        (await access.can(user, "issue.edit", { projectId: b.project_id }))
      )
    ) {
      throw new AppError(
        403,
        "forbidden",
        "You do not have permission to plan this board",
      );
    }
    return b;
  }
  async function sprint(user: AuthUser, id: string, plan = false) {
    const s = await db
      .selectFrom("track_sprint")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!s) throw new AppError(404, "not_found", "Not found");
    await board(user, s.board_id, plan);
    return s;
  }
  const open = (boardId: string) =>
    db
      .selectFrom("track_sprint")
      .select("id")
      .where("board_id", "=", boardId)
      .where("state", "in", ["future", "active"]);

  r.get(
    "/boards/:id/sprints",
    {
      config: custom,
      schema: { params: idParam, response: { 200: z.array(sprintSchema) } },
    },
    async (req) => {
      const b = await board(requireUser(req), req.params.id);
      const rows = await db
        .selectFrom("track_sprint")
        .selectAll()
        .where("board_id", "=", b.id)
        .orderBy("id")
        .execute();
      return rows.map(toSprint);
    },
  );

  r.post(
    "/boards/:id/sprints",
    {
      config: custom,
      schema: {
        params: idParam,
        body: z.object({
          name: z.string().trim().min(1).max(200).optional(),
          goal: z.string().max(1000).default(""),
        }),
        response: { 201: sprintSchema },
      },
    },
    async (req, reply) => {
      const b = await board(requireUser(req), req.params.id, true);
      const count = (
        await db
          .selectFrom("track_sprint")
          .select("id")
          .where("board_id", "=", b.id)
          .execute()
      ).length;
      const s: Sprint = {
        id: uuidv7(),
        board_id: b.id,
        name: req.body.name ?? `${b.name} ${count + 1}`,
        goal: req.body.goal,
        start_at: null,
        end_at: null,
        state: "future",
      };
      await db.insertInto("track_sprint").values(s).execute();
      return reply.status(201).send(toSprint(s));
    },
  );

  r.patch(
    "/sprints/:id",
    {
      config: custom,
      schema: {
        params: idParam,
        body: z
          .object({
            name: z.string().trim().min(1).max(200),
            goal: z.string().max(1000),
            endAt: z.iso.datetime(),
          })
          .partial(),
        response: { 200: sprintSchema },
      },
    },
    async (req) => {
      const s = await sprint(requireUser(req), req.params.id, true);
      if (s.state === "closed")
        throw new AppError(409, "conflict", "A closed sprint cannot change");
      const set = {
        ...(req.body.name !== undefined && { name: req.body.name }),
        ...(req.body.goal !== undefined && { goal: req.body.goal }),
        ...(req.body.endAt !== undefined && {
          end_at: new Date(req.body.endAt),
        }),
      };
      if (Object.keys(set).length)
        await db
          .updateTable("track_sprint")
          .set(set)
          .where("id", "=", s.id)
          .execute();
      return toSprint({ ...s, ...set });
    },
  );

  r.post(
    "/sprints/:id/start",
    {
      config: custom,
      schema: {
        params: idParam,
        body: z.object({ endAt: z.iso.datetime() }),
        response: { 200: sprintSchema },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const s = await sprint(user, req.params.id, true);
      if (s.state !== "future")
        throw new AppError(409, "conflict", "Only a future sprint can start");
      const startAt = new Date();
      const endAt = new Date(req.body.endAt);
      if (endAt <= startAt)
        throw new AppError(400, "validation", "The end must lie in the future");
      await db.transaction().execute(async (trx) => {
        // One active sprint per board. The condition makes two simultaneous starts safe.
        const active = await trx
          .selectFrom("track_sprint")
          .select("id")
          .where("board_id", "=", s.board_id)
          .where("state", "=", "active")
          .executeTakeFirst();
        if (active)
          throw new AppError(
            409,
            "conflict",
            "This board already has an active sprint",
          );
        await trx
          .updateTable("track_sprint")
          .set({ state: "active", start_at: startAt, end_at: endAt })
          .where("id", "=", s.id)
          .where("state", "=", "future")
          .execute();
        await ctx.emit(trx, {
          type: "sprint.started",
          actorId: user.id,
          entityType: "sprint",
          entityId: s.id,
          payload: { boardId: s.board_id },
        });
      });
      return toSprint({
        ...s,
        state: "active",
        start_at: startAt,
        end_at: endAt,
      });
    },
  );

  r.post(
    "/sprints/:id/complete",
    {
      config: custom,
      schema: {
        params: idParam,
        /** Where unfinished tickets go: a future sprint of the same board, or the backlog (null). */
        body: z.object({ moveTo: z.string().nullable().default(null) }),
        response: {
          200: z.object({
            sprint: sprintSchema,
            done: z.number(),
            carried: z.number(),
          }),
        },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const s = await sprint(user, req.params.id, true);
      if (s.state !== "active")
        throw new AppError(
          409,
          "conflict",
          "Only the active sprint can be completed",
        );
      const now = new Date();
      let done = 0;
      let carried = 0;
      await db.transaction().execute(async (trx) => {
        if (req.body.moveTo) {
          const target = await trx
            .selectFrom("track_sprint")
            .select(["id", "board_id", "state"])
            .where("id", "=", req.body.moveTo)
            .executeTakeFirst();
          if (
            !target ||
            target.board_id !== s.board_id ||
            target.state !== "future"
          )
            throw new AppError(
              400,
              "validation",
              "Unfinished tickets can only move to a future sprint of this board",
            );
        }
        const members = await trx
          .selectFrom("track_sprint_issue as si")
          .innerJoin("track_issue as i", "i.id", "si.issue_id")
          .innerJoin("track_status as st", "st.id", "i.status_id")
          .select(["si.issue_id", "st.category"])
          .where("si.sprint_id", "=", s.id)
          .where("si.removed_at", "is", null)
          .execute();
        for (const m of members) {
          if (m.category === "done") {
            done++;
            continue;
          }
          carried++;
          // Stays in this sprint's history as "carried over".
          await trx
            .updateTable("track_sprint_issue")
            .set({ removed_at: now })
            .where("sprint_id", "=", s.id)
            .where("issue_id", "=", m.issue_id)
            .execute();
          if (req.body.moveTo)
            await trx
              .insertInto("track_sprint_issue")
              .values({
                sprint_id: req.body.moveTo,
                issue_id: m.issue_id,
                added_at: now,
                removed_at: null,
              })
              .execute();
        }
        await trx
          .updateTable("track_sprint")
          .set({ state: "closed", end_at: now })
          .where("id", "=", s.id)
          .execute();
        await ctx.emit(trx, {
          type: "sprint.completed",
          actorId: user.id,
          entityType: "sprint",
          entityId: s.id,
          payload: { boardId: s.board_id, done, carried },
        });
      });
      return {
        sprint: toSprint({ ...s, state: "closed", end_at: now }),
        done,
        carried,
      };
    },
  );

  r.delete(
    "/sprints/:id",
    {
      config: custom,
      schema: { params: idParam, response: { 204: z.null() } },
    },
    async (req, reply) => {
      const s = await sprint(requireUser(req), req.params.id, true);
      if (s.state !== "future")
        throw new AppError(
          409,
          "conflict",
          "Only a sprint that has not started can be deleted",
        );
      // Its tickets go back to the backlog (cascade).
      await db.deleteFrom("track_sprint").where("id", "=", s.id).execute();
      return reply.status(204).send(null);
    },
  );

  const memberParams = z.object({ id: z.string(), key: z.string().max(30) });

  r.put(
    "/sprints/:id/issues/:key",
    {
      config: custom,
      schema: { params: memberParams, response: { 204: z.null() } },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const s = await sprint(user, req.params.id, true);
      if (s.state === "closed")
        throw new AppError(409, "conflict", "A closed sprint cannot change");
      const issue = await issues.load(user, req.params.key);
      await access.require(user, "issue.edit", issueTarget(issue));
      const now = new Date();
      await db.transaction().execute(async (trx) => {
        // Out of any other open sprint of this board, then in.
        await trx
          .deleteFrom("track_sprint_issue")
          .where("issue_id", "=", issue.id)
          .where("removed_at", "is", null)
          .where("sprint_id", "in", open(s.board_id))
          .execute();
        await trx
          .insertInto("track_sprint_issue")
          .values({
            sprint_id: s.id,
            issue_id: issue.id,
            added_at: now,
            removed_at: null,
          })
          .execute();
      });
      return reply.status(204).send(null);
    },
  );

  r.delete(
    "/sprints/:id/issues/:key",
    {
      config: custom,
      schema: { params: memberParams, response: { 204: z.null() } },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const s = await sprint(user, req.params.id, true);
      if (s.state === "closed")
        throw new AppError(409, "conflict", "A closed sprint cannot change");
      const issue = await issues.load(user, req.params.key);
      await access.require(user, "issue.edit", issueTarget(issue));
      await db
        .deleteFrom("track_sprint_issue")
        .where("sprint_id", "=", s.id)
        .where("issue_id", "=", issue.id)
        .execute();
      return reply.status(204).send(null);
    },
  );

  r.get(
    "/boards/:id/backlog",
    {
      config: custom,
      schema: {
        params: idParam,
        response: {
          200: z.object({
            sprints: z.array(
              sprintSchema.extend({
                issues: z.array(entry),
                estimateSec: z.number(),
              }),
            ),
            backlog: z.array(entry),
            truncated: z.boolean(),
          }),
        },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const b = await board(user, req.params.id);
      const result = await app.savedQueries.run(user, b.query_id, {
        limit: 1000,
      });
      const visible = new Set(result.rows.map((row) => String(row.id)));
      const sprints = await db
        .selectFrom("track_sprint")
        .selectAll()
        .where("board_id", "=", b.id)
        .where("state", "in", ["future", "active"])
        .orderBy("id")
        .execute();
      const members = sprints.length
        ? await db
            .selectFrom("track_sprint_issue")
            .select(["sprint_id", "issue_id"])
            .where(
              "sprint_id",
              "in",
              sprints.map((s) => s.id),
            )
            .where("removed_at", "is", null)
            .execute()
        : [];
      // Sprint members the viewer may see, plus everything the board's query returns.
      const ids = [...new Set([...visible, ...members.map((m) => m.issue_id)])];
      const rows = ids.length
        ? await db
            .selectFrom("track_issue")
            .selectAll()
            .where("id", "in", ids)
            .orderBy("rank")
            .orderBy("id")
            .execute()
        : [];
      const seen: TrackDb["track_issue"][] = [];
      for (const row of rows)
        if (
          visible.has(row.id) ||
          (await access.can(user, "project.browse", issueTarget(row)))
        )
          seen.push(row);
      const epicTypes = new Set(
        (
          await db
            .selectFrom("track_issue_type")
            .select("id")
            .where("level", ">=", 1)
            .execute()
        ).map((t) => t.id),
      );
      const done = new Set(
        (
          await db
            .selectFrom("track_status")
            .select("id")
            .where("category", "=", "done")
            .execute()
        ).map((s) => s.id),
      );
      const toEntry = (i: TrackDb["track_issue"]): z.infer<typeof entry> => ({
        key: i.key,
        summary: i.summary,
        statusId: i.status_id,
        assigneeId: i.assignee_id,
        estimateSec: i.estimate_sec,
        done: done.has(i.status_id),
        parentId: i.parent_id,
      });
      const inSprint = new Map(members.map((m) => [m.issue_id, m.sprint_id]));
      return {
        sprints: sprints.map((s) => {
          const list = seen.filter((i) => inSprint.get(i.id) === s.id);
          return {
            ...toSprint(s),
            issues: list.map(toEntry),
            estimateSec: list.reduce(
              (sum, i) => sum + (i.estimate_sec ?? 0),
              0,
            ),
          };
        }),
        // The backlog: open tickets of the board that are in no open sprint.
        backlog: seen
          .filter(
            (i) =>
              visible.has(i.id) &&
              !inSprint.has(i.id) &&
              !done.has(i.status_id) &&
              // Epics group the backlog; they are not planned into sprints themselves.
              !epicTypes.has(i.type_id),
          )
          .map(toEntry),
        truncated: result.truncated,
      };
    },
  );
}
