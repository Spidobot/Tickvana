// The only place where SQL differs between database vendors.
// Everything else in the codebase goes through plain Kysely.
import {
  sql,
  type Expression,
  type Kysely,
  type RawBuilder,
  type Transaction,
} from "kysely";

export type DialectName = "postgres" | "mysql";

export interface Dialect {
  readonly name: DialectName;
  /** Column types for migrations. */
  readonly types: {
    /** UUIDv7 as text. */
    id: RawBuilder<unknown>;
    /** UTC timestamp with microseconds. */
    timestamp: RawBuilder<unknown>;
    /** Unbounded text (MySQL `text` stops at 64 KB). Also used for JSON. */
    text: RawBuilder<unknown>;
    blob: RawBuilder<unknown>;
  };
  /** Concatenates the values of a group into one string. */
  stringAgg(
    value: Expression<unknown>,
    separator?: string,
    /** Order of the values inside the string. */
    orderBy?: Expression<unknown>,
  ): RawBuilder<string>;
  /**
   * Lets a database role read a table, or only some of its columns. Used for
   * the read-only role of the query engine.
   */
  grantSelect<DB>(
    db: Kysely<DB>,
    role: string,
    table: string,
    columns?: string[],
  ): Promise<void>;
  /** Runs `fn` in a transaction whose statements are aborted after `ms`. */
  withStatementTimeout<DB, T>(
    db: Kysely<DB>,
    ms: number,
    fn: (trx: Transaction<DB>) => Promise<T>,
    /** Open the transaction read-only, for statements written by users. */
    readOnly?: boolean,
  ): Promise<T>;
}

/** Case-insensitive LIKE. Same SQL on every vendor, regardless of collation. */
export function likeCi(
  value: Expression<unknown>,
  pattern: string,
): RawBuilder<boolean> {
  return sql<boolean>`lower(${value}) like ${pattern.toLowerCase()}`;
}

/** Escapes LIKE wildcards in user input. */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

/** A piece of `text` around the first hit of `query`, for search results. */
export function excerpt(text: string, query: string, size = 160): string {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, (at < 0 ? 0 : at) - size / 3);
  const piece = text
    .slice(start, start + size)
    .replace(/\s+/g, " ")
    .trim();
  return (
    (start > 0 ? "… " : "") + piece + (start + size < text.length ? " …" : "")
  );
}

const begin = <DB>(db: Kysely<DB>, readOnly?: boolean) =>
  readOnly ? db.transaction().setAccessMode("read only") : db.transaction();

const postgres: Dialect = {
  name: "postgres",
  types: {
    id: sql`varchar(36)`,
    timestamp: sql`timestamptz`,
    text: sql`text`,
    blob: sql`bytea`,
  },
  stringAgg: (value, separator = ",", orderBy) =>
    sql<string>`string_agg(cast(${value} as text), ${sql.lit(separator)}${orderBy ? sql` order by ${orderBy}` : sql``})`,
  grantSelect: async (db, role, table, columns) => {
    const cols = columns
      ? sql` (${sql.join(columns.map((c) => sql.id(c)))})`
      : sql``;
    await sql`grant select${cols} on table ${sql.id(table)} to ${sql.id(role)}`.execute(
      db,
    );
  },
  withStatementTimeout: (db, ms, fn, readOnly) =>
    begin(db, readOnly).execute(async (trx) => {
      // `set local` ends with the transaction, so the pooled connection is clean afterwards.
      await sql`set local statement_timeout = ${sql.lit(Math.ceil(ms))}`.execute(
        trx,
      );
      return fn(trx);
    }),
};

const mysql: Dialect = {
  name: "mysql",
  types: {
    id: sql`varchar(36)`,
    timestamp: sql`datetime(6)`,
    text: sql`longtext`,
    blob: sql`longblob`,
  },
  stringAgg: (value, separator = ",", orderBy) =>
    sql<string>`group_concat(${value}${orderBy ? sql` order by ${orderBy}` : sql``} separator ${sql.lit(separator)})`,
  grantSelect: async (db, role, table, columns) => {
    const cols = columns
      ? sql` (${sql.join(columns.map((c) => sql.id(c)))})`
      : sql``;
    // ponytail: assumes the role may connect from any host ('role'@'%'), the usual setup in containers.
    await sql`grant select${cols} on ${sql.id(table)} to ${sql.lit(role)}@${sql.lit("%")}`.execute(
      db,
    );
  },
  withStatementTimeout: (db, ms, fn, readOnly) =>
    begin(db, readOnly).execute(async (trx) => {
      // MariaDB: seconds, session scoped. Reset before the connection returns to the pool.
      // ponytail: MySQL proper needs `max_execution_time` (ms) instead; add when MySQL joins CI.
      await sql`set session max_statement_time = ${sql.lit(ms / 1000)}`.execute(
        trx,
      );
      try {
        return await fn(trx);
      } finally {
        await sql`set session max_statement_time = default`.execute(trx);
      }
    }),
};

export const dialects: Record<DialectName, Dialect> = { postgres, mysql };
