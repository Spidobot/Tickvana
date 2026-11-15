import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import type { Dialect } from "@tvn/core";

/** A change applied to many tickets in the background, with its progress. */
export function bulkOperation({ types }: Dialect): Migration {
  return {
    async up(db: Kysely<never>) {
      await db.schema
        .createTable("track_bulk_operation")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("actor_id", types.id, (c) =>
          c.notNull().references("core_user.id"),
        )
        .addColumn("action_json", types.text, (c) => c.notNull())
        // Ticket keys still to do, in order. Shrinks as the job works.
        .addColumn("pending_json", types.text, (c) => c.notNull())
        .addColumn("total", "integer", (c) => c.notNull())
        .addColumn("done", "integer", (c) => c.notNull())
        // [{ key, message }]
        .addColumn("errors_json", types.text, (c) => c.notNull())
        .addColumn("state", "varchar(20)", (c) => c.notNull()) // running | finished
        .addColumn("created_at", types.timestamp, (c) => c.notNull())
        .addColumn("finished_at", types.timestamp)
        .execute();
    },
  };
}
