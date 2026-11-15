import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import type { Dialect } from "../db/dialect.js";

/** Global permissions (CONCEPT.md §5): who is system admin, may manage users, write free SQL … */
export function globalGrant({ types }: Dialect): Migration {
  return {
    async up(db: Kysely<never>) {
      await db.schema
        .createTable("core_global_grant")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("permission", "varchar(100)", (c) => c.notNull())
        .addColumn("grantee_type", "varchar(20)", (c) => c.notNull()) // user | group | logged_in | anyone
        // User or group id. No foreign key: the column points at two tables.
        .addColumn("grantee_id", types.id)
        .addColumn("created_at", types.timestamp, (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex("idx_core_global_grant_permission")
        .on("core_global_grant")
        .column("permission")
        .execute();
    },
  };
}
