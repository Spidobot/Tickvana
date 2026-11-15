// Saved queries: the "filters" of the product. Boards, queues, dashboards and
// wiki blocks point at one. Running a saved query always uses the rights of
// the person who runs it, never those of its author.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import { requireStaff } from "../auth/routes.js";
import type { AuthUser } from "../auth/store.js";
import { uuidv7 } from "../db/id.js";
import type { Mailer } from "../mail/index.js";
import { SYSTEM_ADMIN, type Permissions } from "../permissions/index.js";
import type { Queue } from "../queue/index.js";
import type { CoreDb } from "../schema.js";
import { AppError } from "../server/index.js";
import { getSetting, setSetting } from "../settings.js";
import {
  QueryError,
  type ParamValue,
  type QueryEngine,
  type QueryResult,
} from "./index.js";

type Row = CoreDb["core_saved_query"];

const paramValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const params = z.record(z.string(), paramValue);
const visibility = z.enum(["private", "group", "global"]);
const querySchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string(),
  sql: z.string(),
  /** Default values for the query's :parameters. */
  params,
  visibility,
  groupId: z.string().nullable(),
  favorite: z.boolean(),
  mine: z.boolean(),
});
const idParam = z.object({ id: z.string() });
const favoritesKey = (userId: string) => `user.${userId}.query-favorites`;
const favoritesSchema = z.object({ ids: z.array(z.string()).default([]) });

const notFound = () => new AppError(404, "not_found", "Not found");
const asAppError = (e: unknown) =>
  e instanceof QueryError
    ? new AppError(
        400,
        "query_invalid",
        e.message,
        e.position === undefined ? undefined : { position: e.position },
      )
    : e;

/** One CSV cell. Quotes what needs quoting and defuses spreadsheet formulas. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  // A cell starting with = + - @ would run as a formula when opened in a spreadsheet.
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(result: QueryResult): string {
  return (
    [
      result.columns.map(csvCell).join(","),
      ...result.rows.map((row) =>
        result.columns.map((c) => csvCell(row[c])).join(","),
      ),
    ].join("\r\n") + "\r\n"
  );
}

export interface SavedQueryOptions {
  db: Kysely<CoreDb>;
  engine: QueryEngine;
  permissions: Permissions;
  queue: Queue;
  mailer: Mailer;
  /** Link to a saved query in the web app. */
  queryUrl: (id: string) => string;
}

export interface SavedQueries {
  /** Loads a query the user may see, or throws 404. */
  load(user: AuthUser | null, id: string): Promise<Row>;
  /** Runs a saved query with the caller's rights. */
  run(
    user: AuthUser | null,
    id: string,
    options?: {
      params?: Record<string, ParamValue>;
      limit?: number;
      offset?: number;
    },
  ): Promise<QueryResult>;
  /** Mails due subscriptions. Returns the number of mails queued. */
  sendSubscriptions(now?: Date): Promise<number>;
}

export async function installSavedQueries(
  scope: FastifyInstance,
  opts: SavedQueryOptions,
): Promise<SavedQueries> {
  const { db, engine, permissions } = opts;
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const own = { permission: "authenticated" as const };

  const visibleTo = async (user: AuthUser | null) => {
    const groups = user ? await permissions.groupIds(user.id) : [];
    return (row: Row) =>
      row.visibility === "global" ||
      (user !== null &&
        (row.owner_id === user.id ||
          (row.visibility === "group" &&
            row.group_id !== null &&
            groups.includes(row.group_id))));
  };
  const favorites = async (user: AuthUser) =>
    new Set((await getSetting(db, favoritesKey(user.id), favoritesSchema)).ids);
  const present = (
    row: Row,
    user: AuthUser,
    favs: Set<string>,
  ): z.infer<typeof querySchema> => ({
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    sql: row.sql,
    params: JSON.parse(row.params_json),
    visibility: row.visibility,
    groupId: row.group_id,
    favorite: favs.has(row.id),
    mine: row.owner_id === user.id,
  });

  async function load(user: AuthUser | null, id: string): Promise<Row> {
    const row = await db
      .selectFrom("core_saved_query")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row || !(await visibleTo(user))(row)) throw notFound();
    return row;
  }
  /** Only the owner or a system administrator changes a query. */
  async function loadOwned(req: FastifyRequest, id: string): Promise<Row> {
    const user = requireStaff(req);
    const row = await load(user, id);
    if (
      row.owner_id !== user.id &&
      !(await permissions.can(user, SYSTEM_ADMIN))
    )
      throw new AppError(
        403,
        "forbidden",
        "Only the owner can change this query",
      );
    return row;
  }
  async function run(
    user: AuthUser | null,
    id: string,
    options: {
      params?: Record<string, ParamValue>;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const row = await load(user, id);
    try {
      return await engine.run(user, row.sql, {
        ...options,
        params: { ...JSON.parse(row.params_json), ...options.params },
      });
    } catch (e) {
      throw asAppError(e);
    }
  }
  /** Sharing with a group needs a group the author belongs to. */
  async function checkSharing(
    user: AuthUser,
    v: z.infer<typeof visibility>,
    groupId: string | null,
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
  const mayWrite = async (user: AuthUser) => {
    if (!(await engine.mayWrite(user)))
      throw new AppError(
        403,
        "forbidden",
        "You do not have permission to write SQL queries",
      );
  };
  const checkSql = (text: string) => {
    try {
      engine.check(text);
    } catch (e) {
      throw asAppError(e);
    }
  };

  r.get(
    "/core/queries",
    { config: own, schema: { response: { 200: z.array(querySchema) } } },
    async (req) => {
      const user = requireStaff(req);
      const [rows, sees, favs] = await Promise.all([
        db.selectFrom("core_saved_query").selectAll().orderBy("name").execute(),
        visibleTo(user),
        favorites(user),
      ]);
      return rows.filter(sees).map((row) => present(row, user, favs));
    },
  );

  const body = z.object({
    name: z.string().trim().min(1).max(200),
    sql: z.string().min(1).max(20_000),
    params: params.default({}),
    visibility: visibility.default("private"),
    groupId: z.string().nullable().default(null),
  });

  r.post(
    "/core/queries",
    { config: own, schema: { body, response: { 201: querySchema } } },
    async (req, reply) => {
      const user = requireStaff(req);
      await mayWrite(user);
      checkSql(req.body.sql);
      const now = new Date();
      const row: Row = {
        id: uuidv7(),
        owner_id: user.id,
        name: req.body.name,
        sql: req.body.sql,
        params_json: JSON.stringify(req.body.params),
        visibility: req.body.visibility,
        group_id: await checkSharing(
          user,
          req.body.visibility,
          req.body.groupId,
        ),
        created_at: now,
        updated_at: now,
      };
      await db.insertInto("core_saved_query").values(row).execute();
      return reply.status(201).send(present(row, user, new Set()));
    },
  );

  r.get(
    "/core/queries/:id",
    {
      config: own,
      schema: { params: idParam, response: { 200: querySchema } },
    },
    async (req) => {
      const user = requireStaff(req);
      return present(
        await load(user, req.params.id),
        user,
        await favorites(user),
      );
    },
  );

  r.patch(
    "/core/queries/:id",
    // No defaults: a default would overwrite fields the caller left out.
    {
      config: own,
      schema: {
        params: idParam,
        body: z
          .object({
            name: z.string().trim().min(1).max(200),
            sql: z.string().min(1).max(20_000),
            params,
            visibility,
            groupId: z.string().nullable(),
          })
          .partial(),
        response: { 200: querySchema },
      },
    },
    async (req) => {
      const user = requireStaff(req);
      const row = await loadOwned(req, req.params.id);
      const { name, sql, params: newParams, groupId } = req.body;
      if (sql !== undefined && sql !== row.sql) {
        await mayWrite(user);
        checkSql(sql);
      }
      const nextVisibility = req.body.visibility ?? row.visibility;
      const next = {
        ...(name !== undefined && { name }),
        ...(sql !== undefined && { sql }),
        ...(newParams !== undefined && {
          params_json: JSON.stringify(newParams),
        }),
        visibility: nextVisibility,
        group_id: await checkSharing(
          user,
          nextVisibility,
          groupId === undefined ? row.group_id : groupId,
        ),
        updated_at: new Date(),
      };
      await db
        .updateTable("core_saved_query")
        .set(next)
        .where("id", "=", row.id)
        .execute();
      return present({ ...row, ...next }, user, await favorites(user));
    },
  );

  r.delete(
    "/core/queries/:id",
    { config: own, schema: { params: idParam, response: { 204: z.null() } } },
    async (req, reply) => {
      const row = await loadOwned(req, req.params.id);
      try {
        await db
          .deleteFrom("core_saved_query")
          .where("id", "=", row.id)
          .execute();
      } catch {
        // A board, queue or dashboard widget still points at it (foreign key).
        throw new AppError(
          409,
          "conflict",
          "This query is still used by a board, queue or dashboard",
        );
      }
      return reply.status(204).send(null);
    },
  );

  const resultSchema = z.object({
    columns: z.array(z.string()),
    rows: z.array(z.record(z.string(), z.unknown())),
    truncated: z.boolean(),
  });

  r.post(
    "/core/queries/:id/run",
    {
      config: own,
      schema: {
        params: idParam,
        body: z.object({
          params: params.default({}),
          limit: z.number().int().min(1).max(10_000).default(200),
          offset: z.number().int().min(0).default(0),
        }),
        response: { 200: resultSchema },
      },
    },
    (req) => run(requireStaff(req), req.params.id, req.body),
  );

  r.get(
    "/core/queries/:id/export",
    {
      config: own,
      schema: {
        params: idParam,
        querystring: z.object({
          format: z.enum(["csv", "json"]).default("csv"),
        }),
      },
    },
    async (req, reply) => {
      const user = requireStaff(req);
      const row = await load(user, req.params.id);
      const result = await run(user, row.id, { limit: 10_000 });
      const file = `${row.name.replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "query"}.${req.query.format}`;
      reply.header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(file)}`,
      );
      if (req.query.format === "json")
        return reply
          .header("content-type", "application/json; charset=utf-8")
          .send(JSON.stringify(result.rows));
      // The BOM makes Excel read the file as UTF-8.
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .send(`\uFEFF${toCsv(result)}`);
    },
  );

  const setFavorite = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    on: boolean,
  ) => {
    const user = requireStaff(req);
    const row = await load(user, req.params.id);
    const ids = await favorites(user);
    if (on) ids.add(row.id);
    else ids.delete(row.id);
    await setSetting(db, favoritesKey(user.id), { ids: [...ids] });
  };
  r.put(
    "/core/queries/:id/favorite",
    { config: own, schema: { params: idParam, response: { 204: z.null() } } },
    async (req, reply) => {
      await setFavorite(req, true);
      return reply.status(204).send(null);
    },
  );
  r.delete(
    "/core/queries/:id/favorite",
    { config: own, schema: { params: idParam, response: { 204: z.null() } } },
    async (req, reply) => {
      await setFavorite(req, false);
      return reply.status(204).send(null);
    },
  );

  // --- Subscriptions: the result by mail on a schedule ------------------------------

  const subscription = z.object({
    /** ISO weekdays, 1 = Monday … 7 = Sunday. */
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    /** Hour of the day in the subscriber's time zone. */
    hour: z.number().int().min(0).max(23),
  });

  r.get(
    "/core/queries/:id/subscription",
    {
      config: own,
      schema: { params: idParam, response: { 200: subscription.nullable() } },
    },
    async (req) => {
      const user = requireStaff(req);
      await load(user, req.params.id);
      const sub = await db
        .selectFrom("core_query_subscription")
        .selectAll()
        .where("query_id", "=", req.params.id)
        .where("user_id", "=", user.id)
        .executeTakeFirst();
      return sub
        ? { weekdays: sub.weekdays.split(",").map(Number), hour: sub.hour }
        : null;
    },
  );

  r.put(
    "/core/queries/:id/subscription",
    {
      config: own,
      schema: {
        params: idParam,
        body: subscription,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const user = requireStaff(req);
      const row = await load(user, req.params.id);
      await db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("core_query_subscription")
          .where("query_id", "=", row.id)
          .where("user_id", "=", user.id)
          .execute();
        await trx
          .insertInto("core_query_subscription")
          .values({
            id: uuidv7(),
            query_id: row.id,
            user_id: user.id,
            weekdays: [...new Set(req.body.weekdays)].sort().join(","),
            hour: req.body.hour,
            last_sent_on: null,
          })
          .execute();
      });
      return reply.status(204).send(null);
    },
  );

  r.delete(
    "/core/queries/:id/subscription",
    { config: own, schema: { params: idParam, response: { 204: z.null() } } },
    async (req, reply) => {
      await db
        .deleteFrom("core_query_subscription")
        .where("query_id", "=", req.params.id)
        .where("user_id", "=", requireStaff(req).id)
        .execute();
      return reply.status(204).send(null);
    },
  );

  /** Weekday (1 = Monday), hour and calendar day of `now` in a time zone. */
  function localTime(now: Date, timeZone: string) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        weekday: "short",
        hour: "2-digit",
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .formatToParts(now)
        .map((p) => [p.type, p.value]),
    );
    return {
      weekday:
        ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(
          parts.weekday!,
        ) + 1,
      hour: Number(parts.hour),
      day: `${parts.year}-${parts.month}-${parts.day}`,
    };
  }

  async function sendSubscriptions(now = new Date()): Promise<number> {
    const subs = await db
      .selectFrom("core_query_subscription as s")
      .innerJoin("core_user as u", "u.id", "s.user_id")
      .innerJoin("core_saved_query as q", "q.id", "s.query_id")
      .select([
        "s.id",
        "s.weekdays",
        "s.hour",
        "s.last_sent_on",
        "s.query_id",
        "q.name",
        "u.id as user_id",
        "u.email",
        "u.display_name",
        "u.kind",
        "u.locale",
        "u.timezone",
        "u.active",
      ])
      .execute();
    let sent = 0;
    for (const s of subs) {
      let local;
      try {
        local = localTime(now, s.timezone);
      } catch {
        local = localTime(now, "UTC");
      }
      if (
        !s.active ||
        s.last_sent_on === local.day ||
        local.hour < s.hour ||
        !s.weekdays.split(",").includes(String(local.weekday))
      )
        continue;

      const user: AuthUser = {
        id: s.user_id,
        email: s.email,
        displayName: s.display_name,
        kind: s.kind,
        locale: s.locale,
        timezone: s.timezone,
      };
      // Claim the day first, so two workers never both send it.
      const claimed = await db
        .updateTable("core_query_subscription")
        .set({ last_sent_on: local.day })
        .where("id", "=", s.id)
        .where((eb) =>
          eb.or([
            eb("last_sent_on", "is", null),
            eb("last_sent_on", "!=", local.day),
          ]),
        )
        .executeTakeFirst();
      if (claimed.numUpdatedRows !== 1n) continue;

      const de = s.locale.startsWith("de");
      let lines: string[];
      try {
        // With the subscriber's rights, like every run.
        const result = await run(user, s.query_id, { limit: 50 });
        lines = [
          de
            ? `${result.rows.length}${result.truncated ? "+" : ""} Zeilen`
            : `${result.rows.length}${result.truncated ? "+" : ""} rows`,
          ...result.rows
            .slice(0, 50)
            .map((row) =>
              result.columns.map((c) => `${c}: ${row[c] ?? ""}`).join(" · "),
            ),
        ];
      } catch (e) {
        // Lost access or a broken statement: say so instead of going silent.
        lines = [
          de
            ? `Die Abfrage konnte nicht ausgeführt werden: ${(e as Error).message}`
            : `The query could not be run: ${(e as Error).message}`,
        ];
      }
      await opts.mailer.send(db, {
        to: s.email,
        subject: s.name,
        body: lines,
        action: {
          label: de ? "Abfrage öffnen" : "Open query",
          url: opts.queryUrl(s.query_id),
        },
      });
      sent++;
    }
    return sent;
  }

  opts.queue.every(
    "query-subscriptions",
    5 * 60_000,
    async () => void (await sendSubscriptions()),
  );

  return { load, run, sendSubscriptions };
}
