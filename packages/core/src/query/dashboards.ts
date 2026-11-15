// Dashboards: a grid of widgets, each a saved query shown as table, number or
// bars (CONCEPT.md §3). Widgets run in the browser through the app that owns
// the query's tables, always with the viewer's rights; a dashboard only keeps
// which query, how to show it and in what order. Shared like saved queries:
// private, with a group, or with everyone. Each user may pick a home dashboard.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { AuthUser } from "../auth/store.js";
import { uuidv7 } from "../db/id.js";
import { requireStaff } from "../auth/routes.js";
import { SYSTEM_ADMIN, type Permissions } from "../permissions/index.js";
import type { CoreDb } from "../schema.js";
import { AppError } from "../server/index.js";
import type { SavedQueries } from "./saved.js";

type Row = CoreDb["core_dashboard"];
const notFound = () => new AppError(404, "not_found", "Not found");
const visibility = z.enum(["private", "group", "global"]);
const widgetConfig = z.object({
  /** The app whose tables the query reads. */
  app: z.enum(["tickvana", "nuvenna"]).default("tickvana"),
  title: z.string().trim().max(200).default(""),
  view: z.enum(["table", "number", "bar"]).default("table"),
  /** Columns of the grid it spans. */
  width: z.union([z.literal(1), z.literal(2)]).default(1),
});
const widgetOut = widgetConfig.extend({
  id: z.string(),
  queryId: z.string(),
});
const dashboardOut = z.object({
  id: z.string(),
  name: z.string(),
  visibility,
  groupId: z.string().nullable(),
  mine: z.boolean(),
  home: z.boolean(),
});
const idParam = z.object({ id: z.string() });

export async function installDashboards(
  scope: FastifyInstance,
  opts: {
    db: Kysely<CoreDb>;
    permissions: Permissions;
    saved: () => SavedQueries;
  },
): Promise<void> {
  const { db, permissions } = opts;
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const own = { permission: "authenticated" as const };

  const sees = async (user: AuthUser, row: Row) =>
    row.visibility === "global" ||
    row.owner_id === user.id ||
    (row.visibility === "group" &&
      row.group_id !== null &&
      (await permissions.groupIds(user.id)).includes(row.group_id));
  async function load(user: AuthUser, id: string) {
    const row = await db
      .selectFrom("core_dashboard")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row || !(await sees(user, row))) throw notFound();
    return row;
  }
  async function loadOwned(req: FastifyRequest, id: string) {
    const user = requireStaff(req);
    const row = await load(user, id);
    if (
      row.owner_id !== user.id &&
      !(await permissions.can(user, SYSTEM_ADMIN))
    )
      throw new AppError(
        403,
        "forbidden",
        "Only the owner can change this dashboard",
      );
    return row;
  }
  async function checkSharing(
    user: AuthUser,
    v: z.infer<typeof visibility>,
    groupId: string | null | undefined,
  ) {
    if (v !== "group") return null;
    if (!groupId || !(await permissions.groupIds(user.id)).includes(groupId))
      throw new AppError(
        400,
        "validation",
        "Choose one of your groups to share with",
      );
    return groupId;
  }
  const homeOf = async (user: AuthUser) =>
    (
      await db
        .selectFrom("core_home_dashboard")
        .select("dashboard_id")
        .where("user_id", "=", user.id)
        .executeTakeFirst()
    )?.dashboard_id ?? null;
  const present = (row: Row, user: AuthUser, home: string | null) => ({
    id: row.id,
    name: row.name,
    visibility: row.visibility,
    groupId: row.group_id,
    mine: row.owner_id === user.id,
    home: row.id === home,
  });
  async function widgets(row: Row) {
    const list = await db
      .selectFrom("core_dashboard_widget")
      .selectAll()
      .where("dashboard_id", "=", row.id)
      .execute();
    const order: string[] = JSON.parse(row.layout_json);
    return list
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
      .map((w) => ({
        id: w.id,
        queryId: w.query_id,
        ...widgetConfig.parse({ ...JSON.parse(w.config_json), view: w.kind }),
      }));
  }

  r.get(
    "/core/dashboards",
    { config: own, schema: { response: { 200: z.array(dashboardOut) } } },
    async (req) => {
      const user = requireStaff(req);
      const rows = await db
        .selectFrom("core_dashboard")
        .selectAll()
        .orderBy("name")
        .execute();
      const home = await homeOf(user);
      const out = [];
      for (const row of rows)
        if (await sees(user, row)) out.push(present(row, user, home));
      return out;
    },
  );

  r.post(
    "/core/dashboards",
    {
      config: own,
      schema: {
        body: z.object({
          name: z.string().trim().min(1).max(200),
          visibility: visibility.default("private"),
          groupId: z.string().nullable().optional(),
        }),
        response: { 201: dashboardOut },
      },
    },
    async (req, reply) => {
      const user = requireStaff(req);
      const now = new Date();
      const row: Row = {
        id: uuidv7(),
        owner_id: user.id,
        name: req.body.name,
        visibility: req.body.visibility,
        group_id: await checkSharing(
          user,
          req.body.visibility,
          req.body.groupId,
        ),
        layout_json: "[]",
        created_at: now,
        updated_at: now,
      };
      await db.insertInto("core_dashboard").values(row).execute();
      return reply.status(201).send(present(row, user, null));
    },
  );

  r.get(
    "/core/dashboards/:id",
    {
      config: own,
      schema: {
        params: idParam,
        response: { 200: dashboardOut.extend({ widgets: z.array(widgetOut) }) },
      },
    },
    async (req) => {
      const user = requireStaff(req);
      const row = await load(user, req.params.id);
      return {
        ...present(row, user, await homeOf(user)),
        widgets: await widgets(row),
      };
    },
  );

  r.patch(
    "/core/dashboards/:id",
    {
      config: own,
      schema: {
        params: idParam,
        body: z
          .object({
            name: z.string().trim().min(1).max(200),
            visibility,
            groupId: z.string().nullable(),
            /** Widget ids in the order to show them. */
            order: z.array(z.string()).max(100),
          })
          .partial(),
        response: { 200: dashboardOut },
      },
    },
    async (req) => {
      const user = requireStaff(req);
      const row = await loadOwned(req, req.params.id);
      const v = req.body.visibility ?? row.visibility;
      const next: Partial<Row> = {
        updated_at: new Date(),
        ...(req.body.name !== undefined && { name: req.body.name }),
        ...(req.body.visibility !== undefined && {
          visibility: v,
          group_id: await checkSharing(
            user,
            v,
            req.body.groupId ?? row.group_id,
          ),
        }),
        ...(req.body.order && { layout_json: JSON.stringify(req.body.order) }),
      };
      await db
        .updateTable("core_dashboard")
        .set(next)
        .where("id", "=", row.id)
        .execute();
      return present({ ...row, ...next }, user, await homeOf(user));
    },
  );

  r.delete(
    "/core/dashboards/:id",
    { config: own, schema: { params: idParam, response: { 204: z.null() } } },
    async (req, reply) => {
      const row = await loadOwned(req, req.params.id);
      await db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("core_home_dashboard")
          .where("dashboard_id", "=", row.id)
          .execute();
        await trx
          .deleteFrom("core_dashboard_widget")
          .where("dashboard_id", "=", row.id)
          .execute();
        await trx
          .deleteFrom("core_dashboard")
          .where("id", "=", row.id)
          .execute();
      });
      return reply.status(204).send(null);
    },
  );

  r.post(
    "/core/dashboards/:id/widgets",
    {
      config: own,
      schema: {
        params: idParam,
        body: widgetConfig.extend({ queryId: z.string() }),
        response: { 201: widgetOut },
      },
    },
    async (req, reply) => {
      const user = requireStaff(req);
      const row = await loadOwned(req, req.params.id);
      // Only queries the author may see; viewers are checked again when it runs.
      await opts.saved().load(user, req.body.queryId);
      const { queryId, view, ...config } = req.body;
      const id = uuidv7();
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto("core_dashboard_widget")
          .values({
            id,
            dashboard_id: row.id,
            query_id: queryId,
            kind: view,
            config_json: JSON.stringify(config),
          })
          .execute();
        await trx
          .updateTable("core_dashboard")
          .set({
            layout_json: JSON.stringify([...JSON.parse(row.layout_json), id]),
            updated_at: new Date(),
          })
          .where("id", "=", row.id)
          .execute();
      });
      return reply.status(201).send({ id, queryId, view, ...config });
    },
  );

  r.delete(
    "/core/dashboards/:id/widgets/:widgetId",
    {
      config: own,
      schema: {
        params: idParam.extend({ widgetId: z.string() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const row = await loadOwned(req, req.params.id);
      await db
        .deleteFrom("core_dashboard_widget")
        .where("id", "=", req.params.widgetId)
        .where("dashboard_id", "=", row.id)
        .execute();
      return reply.status(204).send(null);
    },
  );

  r.put(
    "/core/me/home-dashboard",
    {
      config: own,
      schema: {
        body: z.object({ dashboardId: z.string().nullable() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const user = requireStaff(req);
      if (req.body.dashboardId) await load(user, req.body.dashboardId);
      await db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("core_home_dashboard")
          .where("user_id", "=", user.id)
          .execute();
        if (req.body.dashboardId)
          await trx
            .insertInto("core_home_dashboard")
            .values({ user_id: user.id, dashboard_id: req.body.dashboardId })
            .execute();
      });
      return reply.status(204).send(null);
    },
  );
}
