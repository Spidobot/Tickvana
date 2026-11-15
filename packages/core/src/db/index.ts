import { Kysely, MysqlDialect, PostgresDialect, sql } from "kysely";
import {
  Migrator,
  type Migration,
  type MigrationResult,
} from "kysely/migration";
import { createPool } from "mysql2";
import pg from "pg";
import { dialects, type Dialect } from "./dialect.js";

export * from "./dialect.js";
export { uuidv7 } from "./id.js";

export interface Database<DB> {
  readonly db: Kysely<DB>;
  readonly dialect: Dialect;
}

/** Opens a connection pool. The URL scheme picks the dialect. */
export function createDb<DB>(url: string): Database<DB> {
  const scheme = new URL(url).protocol.slice(0, -1);
  switch (scheme) {
    case "postgres":
    case "postgresql":
      return {
        dialect: dialects.postgres,
        db: new Kysely<DB>({
          dialect: new PostgresDialect({
            pool: new pg.Pool({
              connectionString: url,
              // DATE columns stay "YYYY-MM-DD" strings: a calendar day has no time zone.
              types: {
                getTypeParser: (oid: number, format?: string) =>
                  oid === 1082
                    ? (v: string) => v
                    : pg.types.getTypeParser(oid, format as "text"),
              } as pg.CustomTypesConfig,
            }),
          }),
        }),
      };
    case "mysql":
    case "mariadb":
      return {
        dialect: dialects.mysql,
        db: new Kysely<DB>({
          dialect: new MysqlDialect({
            // timezone Z: datetime columns hold UTC, never the server's local time.
            pool: createPool({
              uri: url.replace(/^mariadb:/, "mysql:"),
              timezone: "Z",
              dateStrings: ["DATE"],
              // tinyint(1) is MariaDB's boolean. Return true/false like PostgreSQL does.
              typeCast: (field, next) => {
                if (field.type === "TINY" && field.length === 1) {
                  const v = field.string();
                  return v === null ? null : v === "1";
                }
                return next();
              },
            }),
          }),
        }),
      };
    default:
      throw new Error(
        `Unsupported database scheme "${scheme}". Use postgres:// or mysql://`,
      );
  }
}

/**
 * Applies pending migrations of one module ("core", "track", "pages": the names of the table prefixes).
 * Each module keeps its own bookkeeping tables. Kysely holds a database lock
 * while migrating, so several containers may start at the same time.
 */
export async function migrate<DB>(
  db: Kysely<DB>,
  module: string,
  migrations: Record<string, Migration>,
): Promise<MigrationResult[]> {
  const migrator = new Migrator({
    db: db as Kysely<unknown>,
    provider: { getMigrations: async () => migrations },
    migrationTableName: `${module}_migration`,
    migrationLockTableName: `${module}_migration_lock`,
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error;
  return results ?? [];
}

/** Throws when the database does not answer. */
export async function ping<DB>(db: Kysely<DB>): Promise<void> {
  await sql`select 1`.execute(db);
}
