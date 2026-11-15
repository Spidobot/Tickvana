// Boards: a saved query decides which tickets are on it, columns map
// statuses, swimlanes group rows. Dragging a card runs the transition into
// the column and sets its rank in one call.
import {
  AppError,
  requireUser,
  uuidv7,
  type AppContext,
  type AuthUser,
  type CoreDb,
} from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import { issueTarget } from "../access.js";
import type { TrackContext } from "../context.js";
import { placeBetween } from "../rank.js";
import type { TrackDb } from "../db/schema.js";
import type { IssueService } from "../issues.js";
import type { WorkflowService } from "../workflow.js";

const MAX_CARDS = 500;

const column = z.object({
  name: z.string().trim().min(1).max(100),
  statusIds: z.array(z.string()).min(1),
  /** Cards above this are shown as over the limit. */
  wipLimit: z.number().int().min(1).nullable().default(null),
});
const swimlane = z.object({
  by: z.enum(["none", "assignee", "priority", "parent"]).default("none"),
});
const boardSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["scrum", "kanban"]),
  projectKey: z.string().nullable(),
  queryId: z.string(),
  columns: z.array(column),
  swimlanes: swimlane,
});
const idParam = z.object({ id: z.string() });
type Board = TrackDb["track_board"];

export async function boardRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
  app: AppContext,
  issues: IssueService,
  workflows: WorkflowService,
): Promise<void> {
  const { db, access } = ctx;
  const r = scope.withTypeProvider<ZodTypeProvider>();
  // Every handler checks: the board's query decides what anyone sees on it.
  const custom = { permission: "custom" as const };

  const projectKey = async (id: string | null) =>
    id
      ? ((
          await db
            .selectFrom("track_project")
            .select("key")
            .where("id", "=", id)
            .executeTakeFirst()
        )?.key ?? null)
      : null;
  const present = async (b: Board): Promise<z.infer<typeof boardSchema>> => ({
    id: b.id,
    name: b.name,
    kind: b.kind,
    projectKey: await projectKey(b.project_id),
    queryId: b.query_id,
    columns: JSON.parse(b.columns_json),
    swimlanes: JSON.parse(b.swimlane_json),
  });

  /** A board is visible to whoever may see its query. */
  async function load(user: AuthUser | null, id: string): Promise<Board> {
    // Boards are for signed-in people, even when their query is shared with everyone.
    if (!user) throw new AppError(401, "unauthenticated", "Sign in required");
    const board = await db
      .selectFrom("track_board")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!board) throw new AppError(404, "not_found", "Not found");
    await app.savedQueries.load(user, board.query_id);
    return board;
  }
  /** Administrators of the board's project change it; boards without a project, system admins. */
  async function loadForAdmin(user: AuthUser, id: string): Promise<Board> {
    const board = await load(user, id);
    const allowed = board.project_id
      ? await access.can(user, "project.administer", {
          projectId: board.project_id,
        })
      : await ctx.permissions.can(user, "system.admin");
    if (!allowed)
      throw new AppError(
        403,
        "forbidden",
        "You do not have permission to do this",
      );
    return board;
  }
  /** Statuses used in a column must exist. */
  async function checkColumns(columns: z.infer<typeof column>[]) {
    const ids = [...new Set(columns.flatMap((c) => c.statusIds))];
    const known = await db
      .selectFrom("track_status")
      .select("id")
      .where("id", "in", ids)
      .execute();
    if (known.length !== ids.length)
      throw new AppError(
        400,
        "validation",
        "A column names a status that does not exist",
      );
    if (ids.length !== columns.flatMap((c) => c.statusIds).length)
      throw new AppError(
        400,
        "validation",
        "A status can be in one column only",
      );
  }

  r.get(
    "/projects/:key/boards",
    {
      config: custom,
      schema: {
        params: z.object({ key: z.string().max(10) }),
        response: { 200: z.array(boardSchema) },
      },
    },
    async (req) => {
      const project = await ctx.project(req.user, req.params.key);
      const rows = await db
        .selectFrom("track_board")
        .selectAll()
        .where("project_id", "=", project.id)
        .orderBy("name")
        .execute();
      return Promise.all(rows.map(present));
    },
  );

  r.post(
    "/projects/:key/boards",
    {
      config: custom,
      schema: {
        params: z.object({ key: z.string().max(10) }),
        body: z.object({
          name: z.string().trim().min(1).max(200),
          kind: z.enum(["scrum", "kanban"]).default("kanban"),
        }),
        response: { 201: boardSchema },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const project = await ctx.project(
        user,
        req.params.key,
        "project.administer",
      );
      // One column per status of the project's default workflow, in its order.
      const d = await ctx.defaults();
      const statuses = await db
        .selectFrom("track_workflow_status as ws")
        .innerJoin("track_status as s", "s.id", "ws.status_id")
        .select(["s.id", "s.name"])
        .where("ws.workflow_id", "=", d.workflowId)
        .orderBy("ws.x")
        .execute();
      const now = new Date();
      const queryId = uuidv7();
      const board: Board = {
        id: uuidv7(),
        name: req.body.name,
        kind: req.body.kind,
        query_id: queryId,
        columns_json: JSON.stringify(
          statuses.map((s) => ({
            name: s.name,
            statusIds: [s.id],
            wipLimit: null,
          })),
        ),
        swimlane_json: JSON.stringify({ by: "none" }),
        estimate_field_id: null,
        project_id: project.id,
      };
      await db.transaction().execute(async (trx) => {
        // The board's query is written here, not by the user: no SQL permission needed.
        await (trx as unknown as Kysely<CoreDb>)
          .insertInto("core_saved_query")
          .values({
            id: queryId,
            owner_id: user.id,
            name: `${project.key}: ${req.body.name}`,
            sql: "select id from issues where project_key = :project",
            params_json: JSON.stringify({ project: project.key }),
            visibility: "global",
            group_id: null,
            created_at: now,
            updated_at: now,
          })
          .execute();
        await trx.insertInto("track_board").values(board).execute();
      });
      return reply.status(201).send(await present(board));
    },
  );

  r.get(
    "/boards/:id",
    {
      config: custom,
      schema: { params: idParam, response: { 200: boardSchema } },
    },
    async (req) => present(await load(req.user, req.params.id)),
  );

  r.patch(
    "/boards/:id",
    {
      config: custom,
      schema: {
        params: idParam,
        body: z
          .object({
            name: z.string().trim().min(1).max(200),
            columns: z.array(column).min(1).max(20),
            swimlanes: swimlane,
            queryId: z.string(),
          })
          .partial(),
        response: { 200: boardSchema },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const board = await loadForAdmin(user, req.params.id);
      const { name, columns, swimlanes, queryId } = req.body;
      if (columns) await checkColumns(columns);
      // Pointing the board at another query needs a query the admin may see.
      if (queryId) await app.savedQueries.load(user, queryId);
      await db
        .updateTable("track_board")
        .set({
          ...(name !== undefined && { name }),
          ...(columns && { columns_json: JSON.stringify(columns) }),
          ...(swimlanes && { swimlane_json: JSON.stringify(swimlanes) }),
          ...(queryId && { query_id: queryId }),
        })
        .where("id", "=", board.id)
        .execute();
      return present(await load(user, board.id));
    },
  );

  r.delete(
    "/boards/:id",
    {
      config: custom,
      schema: { params: idParam, response: { 204: z.null() } },
    },
    async (req, reply) => {
      const board = await loadForAdmin(requireUser(req), req.params.id);
      await db.deleteFrom("track_board").where("id", "=", board.id).execute();
      return reply.status(204).send(null);
    },
  );

  const card = z.object({
    key: z.string(),
    summary: z.string(),
    typeId: z.string(),
    statusId: z.string(),
    priorityId: z.string(),
    assigneeId: z.string().nullable(),
    parentId: z.string().nullable(),
    estimateSec: z.number().nullable(),
    labels: z.array(z.string()),
  });

  type CardWithId = z.infer<typeof card> & { id: string };
  const stripId = ({ id, ...rest }: CardWithId): z.infer<typeof card> => (
    void id,
    rest
  );

  /** Cards for ticket ids, ordered by rank. */
  async function cardsFor(ids: string[]): Promise<CardWithId[]> {
    if (ids.length === 0) return [];
    const rows = await db
      .selectFrom("track_issue")
      .selectAll()
      .where("id", "in", ids)
      .orderBy("rank")
      .orderBy("id")
      .execute();
    return (await issues.present(rows)).map((i) => ({
      id: i.id,
      key: i.key,
      summary: i.fields.summary as string,
      typeId: i.fields.type as string,
      statusId: i.fields.status as string,
      priorityId: i.fields.priority as string,
      assigneeId: (i.fields.assignee as string | null) ?? null,
      parentId: (i.fields.parent as string | null) ?? null,
      estimateSec: (i.fields.estimate as number | null) ?? null,
      labels: i.fields.labels as string[],
    }));
  }

  /** Ids of the tickets in a board's active sprint, or an empty set. */
  async function activeSprintIssueIds(boardId: string): Promise<Set<string>> {
    const rows = await db
      .selectFrom("track_sprint as s")
      .innerJoin("track_sprint_issue as si", "si.sprint_id", "s.id")
      .select("si.issue_id")
      .where("s.board_id", "=", boardId)
      .where("s.state", "=", "active")
      .where("si.removed_at", "is", null)
      .execute();
    return new Set(rows.map((r) => r.issue_id));
  }

  r.get(
    "/boards/:id/cards",
    {
      config: custom,
      schema: {
        params: idParam,
        response: {
          200: z.object({
            columns: z.array(
              column.extend({ cards: z.array(card), overLimit: z.boolean() }),
            ),
            /** Cards whose status has no column. */
            unmapped: z.number(),
            truncated: z.boolean(),
          }),
        },
      },
    },
    async (req) => {
      const board = await load(req.user, req.params.id);
      const columns = column.array().parse(JSON.parse(board.columns_json));
      // The query runs with the viewer's rights: everyone sees their own board.
      const result = await app.savedQueries.run(req.user, board.query_id, {
        limit: MAX_CARDS,
      });
      if (result.rows.length && !result.columns.includes("id"))
        throw new AppError(
          400,
          "query_invalid",
          "The board's query must return a column called id",
        );
      const all = await cardsFor(result.rows.map((row) => String(row.id)));
      // A scrum board shows the active sprint only.
      const active =
        board.kind === "scrum"
          ? await activeSprintIssueIds(board.id)
          : undefined;
      const cards = active ? all.filter((c) => active.has(c.id)) : all;
      const placed = columns.map((c) => {
        const inColumn = cards
          .filter((i) => c.statusIds.includes(i.statusId))
          .map(stripId);
        return {
          ...c,
          cards: inColumn,
          overLimit: c.wipLimit !== null && inColumn.length > c.wipLimit,
        };
      });
      const mapped = new Set(columns.flatMap((c) => c.statusIds));
      return {
        columns: placed,
        unmapped: cards.filter((i) => !mapped.has(i.statusId)).length,
        truncated: result.truncated,
      };
    },
  );

  r.post(
    "/boards/:id/move",
    {
      config: custom,
      schema: {
        params: idParam,
        body: z.object({
          key: z.string().max(30),
          column: z.number().int().min(0),
          afterKey: z.string().max(30).optional(),
          beforeKey: z.string().max(30).optional(),
        }),
        response: { 200: z.object({ statusId: z.string() }) },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const board = await load(user, req.params.id);
      const columns = column.array().parse(JSON.parse(board.columns_json));
      const target = columns[req.body.column];
      if (!target) throw new AppError(400, "validation", "Unknown column");
      let issue = await issues.load(user, req.body.key);

      if (!target.statusIds.includes(issue.status_id)) {
        await access.require(user, "issue.transition", issueTarget(issue));
        // The first status of the column that a transition reaches.
        const available = await workflows.available(user, issue.key);
        const transition = target.statusIds
          .map((s) => available.find((t) => t.toStatusId === s))
          .find(Boolean);
        if (!transition)
          throw new AppError(
            409,
            "conflict",
            "No transition leads into this column from the ticket's status",
          );
        await workflows.transition(user, issue.key, transition.id, {});
        issue = await issues.load(user, issue.key);
      }
      if (req.body.afterKey || req.body.beforeKey) {
        await access.require(user, "issue.edit", issueTarget(issue));
        const neighbour = async (key?: string) =>
          key ? (await issues.load(user, key)).id : undefined;
        const rank = await placeBetween(
          db,
          issue.id,
          await neighbour(req.body.afterKey),
          await neighbour(req.body.beforeKey),
        );
        if (!rank)
          throw new AppError(
            409,
            "conflict",
            "The board changed in the meantime. Reload and try again",
          );
      }
      return { statusId: issue.status_id };
    },
  );
}
