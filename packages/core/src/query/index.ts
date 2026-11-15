// The query engine (CONCEPT.md §3): users write SELECT statements against
// virtual tables. Each virtual table is generated per query as a CTE that
// contains only what the asking user may see.
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { sql, type Expression, type Kysely, type RawBuilder } from "kysely";
import { z } from "zod";
import type { AuthUser } from "../auth/store.js";
import type { Dialect } from "../db/dialect.js";
import type { CoreDb } from "../schema.js";
import { SYSTEM_ADMIN, type Permissions } from "../permissions/index.js";
import { AppError } from "../server/index.js";
import { QueryError, scanSql, validateQuery } from "./validate.js";

export { QueryError } from "./validate.js";
export type { SavedQueries } from "./saved.js";
export { csvCell, toCsv } from "./saved.js";

export interface CatalogColumn {
  name: string;
  /** text | number | date | datetime | boolean */
  type: string;
  description: string;
}

/** What a virtual table is built for: who asks and which optional columns the query uses. */
export interface BuildContext {
  user: AuthUser | null;
  /** cf_ columns the query references, lower-cased. With `star`, build all of them. */
  customColumns: ReadonlySet<string>;
  star: boolean;
}

export interface VirtualTable {
  /** Lower-case, not a reserved word in any supported database. */
  name: string;
  description: string;
  /** Other virtual tables this one's SELECT reads, e.g. comments read issues. */
  needs?: string[];
  /** Columns for the catalog. A function when they depend on configuration (custom fields). */
  columns: CatalogColumn[] | (() => Promise<CatalogColumn[]>);
  /**
   * Physical tables the SELECT reads, for granting the read-only role exactly
   * that. Name columns where a table also holds things queries must never see.
   */
  reads: { table: string; columns?: string[] }[];
  /** The SELECT behind the table, already restricted to what the user may see. */
  build(ctx: BuildContext): Promise<Expression<unknown>>;
}

export type ParamValue = string | number | boolean | null;

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** True when more rows exist beyond `limit`. */
  truncated: boolean;
}

export interface QueryEngine {
  register(table: VirtualTable): void;
  catalog(): Promise<
    { name: string; description: string; columns: CatalogColumn[] }[]
  >;
  /** Checks a statement without running it. Throws QueryError. */
  check(sqlText: string): void;
  /** Runs a statement as `user`. Throws QueryError for anything wrong with the statement. */
  run(
    user: AuthUser | null,
    sqlText: string,
    options?: {
      params?: Record<string, ParamValue>;
      limit?: number;
      offset?: number;
    },
  ): Promise<QueryResult>;
  /** Everything the read-only role must be allowed to read, merged over all tables. */
  grants(): { table: string; columns?: string[] }[];
  /** May this user write free SQL? Without a read-only role only system admins may. */
  mayWrite(user: AuthUser | null): Promise<boolean>;
  /** False when DB_QUERY_URL is not configured and queries run on the main connection. */
  readonly isolated: boolean;
}

export interface QueryEngineOptions {
  /** Connection the statements run on. Should use a read-only database role. */
  db: Kysely<unknown>;
  dialect: Dialect;
  permissions: Permissions;
  /** True when `db` is a separate connection with a read-only role (DB_QUERY_URL). */
  isolated: boolean;
  timeoutMs?: number;
  maxRows?: number;
}

export function createQueryEngine(opts: QueryEngineOptions): QueryEngine {
  const tables = new Map<string, VirtualTable>();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRows = opts.maxRows ?? 10_000;
  const names = () => new Set(tables.keys());

  /** The tables a query reads plus what those need, dependencies first. */
  function ordered(used: Iterable<string>): VirtualTable[] {
    const out: VirtualTable[] = [];
    const seen = new Set<string>();
    const visit = (name: string) => {
      if (seen.has(name)) return;
      seen.add(name);
      const table = tables.get(name);
      if (!table) throw new Error(`Virtual table "${name}" is not registered`);
      (table.needs ?? []).forEach(visit);
      out.push(table);
    };
    for (const name of used) visit(name);
    return out;
  }

  return {
    isolated: opts.isolated,

    register(table) {
      if (!/^[a-z][a-z0-9_]*$/.test(table.name))
        throw new Error(`Invalid virtual table name "${table.name}"`);
      if (tables.has(table.name))
        throw new Error(`Virtual table "${table.name}" is already registered`);
      tables.set(table.name, table);
    },

    async catalog() {
      const out = [];
      for (const t of [...tables.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        out.push({
          name: t.name,
          description: t.description,
          columns:
            typeof t.columns === "function" ? await t.columns() : t.columns,
        });
      }
      return out;
    },

    check(sqlText) {
      validateQuery(
        scanSql(sqlText, opts.dialect.name).parseText,
        opts.dialect.name,
        names(),
      );
    },

    grants() {
      const merged = new Map<string, Set<string> | null>();
      for (const t of tables.values()) {
        for (const r of t.reads) {
          const known = merged.get(r.table);
          // null: the whole table. A column list only narrows while nobody asks for all.
          if (known === null) continue;
          if (!r.columns) merged.set(r.table, null);
          else merged.set(r.table, new Set([...(known ?? []), ...r.columns]));
        }
      }
      return [...merged].map(([table, columns]) =>
        columns ? { table, columns: [...columns] } : { table },
      );
    },

    async mayWrite(user) {
      return opts.permissions.can(
        user,
        opts.isolated ? "query.sql" : SYSTEM_ADMIN,
      );
    },

    async run(user, sqlText, { params = {}, limit = 1000, offset = 0 } = {}) {
      const scanned = scanSql(sqlText, opts.dialect.name);
      const info = validateQuery(scanned.parseText, opts.dialect.name, names());

      // Built-in parameters cannot be overridden by the caller.
      const values: Record<string, ParamValue | Date> = {
        ...params,
        current_user: user?.id ?? null,
        now: new Date(),
      };
      const statement = sql.join(
        scanned.parts.map((part): RawBuilder<unknown> => {
          if (typeof part === "string") return sql.raw(part);
          if (!Object.hasOwn(values, part.param))
            throw new QueryError(`No value given for parameter :${part.param}`);
          // Always bound, never pasted into the text.
          return sql`${values[part.param]}`;
        }),
        sql.raw(""),
      );

      const ctx: BuildContext = {
        user,
        customColumns: info.customColumns,
        star: info.star,
      };
      const ctes: RawBuilder<unknown>[] = [];
      for (const table of ordered(info.tables)) {
        ctes.push(sql`${sql.id(table.name)} as (${await table.build(ctx)})`);
      }
      const rows = Math.max(1, Math.min(limit, maxRows));
      // The user's statement becomes the last CTE. Wrapping it as a derived
      // table instead would break on MariaDB, which does not let a WITH inside
      // a derived table see the outer CTEs (it does inside a CTE).
      // MariaDB drops an ORDER BY inside a CTE unless it has a LIMIT there:
      // give a sorted statement one that covers the page, so its order survives.
      const sorted = info.orderedWithoutLimit
        ? sql`${statement} limit ${sql.lit(Math.max(0, offset) + rows + 1)}`
        : statement;
      ctes.push(sql`tw_result as (${sorted})`);
      const query = sql<
        Record<string, unknown>
      >`with ${sql.join(ctes, sql`, `)} select * from tw_result limit ${sql.lit(rows + 1)} offset ${sql.lit(Math.max(0, offset))}`;

      let result;
      try {
        result = await opts.dialect.withStatementTimeout(
          opts.db,
          timeoutMs,
          (trx) => query.execute(trx),
          true,
        );
      } catch (e) {
        if (e instanceof QueryError) throw e;
        const message = e instanceof Error ? e.message : String(e);
        // The database's own words help the author fix the statement.
        throw new QueryError(
          /timeout|max_statement_time|interrupted/i.test(message)
            ? `The query ran longer than ${timeoutMs / 1000} seconds and was stopped`
            : message,
        );
      }
      const truncated = result.rows.length > rows;
      const page = truncated ? result.rows.slice(0, rows) : result.rows;
      return {
        columns: page[0] ? Object.keys(page[0]) : [],
        rows: page,
        truncated,
      };
    },
  };
}

/** GET /core/query/catalog and POST /core/query/run. */
export async function installQueryRoutes(
  scope: FastifyInstance,
  engine: QueryEngine,
  /** Statements per minute and client address. */
  ratePerMinute = 60,
): Promise<void> {
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const column = z.object({
    name: z.string(),
    type: z.string(),
    description: z.string(),
  });

  r.get(
    "/core/query/catalog",
    {
      config: { permission: "authenticated" as const },
      schema: {
        response: {
          200: z.object({
            /** May the caller write free SQL, or only run saved queries? */
            mayWrite: z.boolean(),
            tables: z.array(
              z.object({
                name: z.string(),
                description: z.string(),
                columns: z.array(column),
              }),
            ),
          }),
        },
      },
    },
    async (req) => ({
      mayWrite: await engine.mayWrite(req.user),
      tables: await engine.catalog(),
    }),
  );

  r.post(
    "/core/query/run",
    {
      // The handler decides: the needed permission depends on how the engine is set up.
      config: {
        permission: "custom" as const,
        rateLimit: { max: ratePerMinute, timeWindow: "1 minute" },
      },
      schema: {
        body: z.object({
          sql: z.string().max(20_000),
          params: z
            .record(
              z.string(),
              z.union([z.string(), z.number(), z.boolean(), z.null()]),
            )
            .default({}),
          limit: z.number().int().min(1).max(10_000).default(200),
          offset: z.number().int().min(0).default(0),
        }),
        response: {
          200: z.object({
            columns: z.array(z.string()),
            rows: z.array(z.record(z.string(), z.unknown())),
            truncated: z.boolean(),
          }),
        },
      },
    },
    async (req) => {
      if (!req.user)
        throw new AppError(401, "unauthenticated", "Sign in required");
      if (!(await engine.mayWrite(req.user)))
        throw new AppError(
          403,
          "forbidden",
          "You do not have permission to write SQL queries",
        );
      try {
        return await engine.run(req.user, req.body.sql, req.body);
      } catch (e) {
        if (e instanceof QueryError)
          throw new AppError(
            400,
            "query_invalid",
            e.message,
            e.position === undefined ? undefined : { position: e.position },
          );
        throw e;
      }
    },
  );
}

/** The people of the installation. Portal customers see only themselves. */
export function usersTable(db: Kysely<CoreDb>): VirtualTable {
  return {
    name: "users",
    description: "People with an account",
    columns: [
      { name: "id", type: "text", description: "User id" },
      { name: "display_name", type: "text", description: "Name" },
      { name: "email", type: "text", description: "E-mail address" },
      {
        name: "kind",
        type: "text",
        description: "internal, customer or service",
      },
      {
        name: "active",
        type: "boolean",
        description: "False for deactivated accounts",
      },
    ],
    // Never the password hash.
    reads: [
      {
        table: "core_user",
        columns: ["id", "display_name", "email", "kind", "active"],
      },
    ],
    async build({ user }) {
      let query = db
        .selectFrom("core_user")
        .select(["id", "display_name", "email", "kind", "active"]);
      if (!user) query = query.where(sql<boolean>`1 = 0`);
      else if (user.kind === "customer")
        query = query.where("id", "=", user.id);
      return query;
    },
  };
}

export function groupsTable(db: Kysely<CoreDb>): VirtualTable {
  return {
    // "groups" is a reserved word in MySQL and MariaDB.
    name: "user_groups",
    description: "Groups of people, for staff",
    columns: [
      { name: "id", type: "text", description: "Group id" },
      { name: "name", type: "text", description: "Name" },
    ],
    reads: [{ table: "core_group", columns: ["id", "name"] }],
    async build({ user }) {
      const query = db.selectFrom("core_group").select(["id", "name"]);
      // Portal customers see no groups, as in the user pickers.
      return !user || user.kind === "customer"
        ? query.where(sql<boolean>`1 = 0`)
        : query;
    },
  };
}
