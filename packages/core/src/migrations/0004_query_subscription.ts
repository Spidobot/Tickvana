import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import type { Dialect } from "../db/dialect.js";

/** A saved query mailed to a person on chosen weekdays at a chosen hour. */
export function querySubscription({ types }: Dialect): Migration {
  return {
    async up(db: Kysely<never>) {
      await db.schema
        .createTable("core_query_subscription")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("query_id", types.id, (c) =>
          c.notNull().references("core_saved_query.id").onDelete("cascade"),
        )
        .addColumn("user_id", types.id, (c) =>
          c.notNull().references("core_user.id"),
        )
        // ISO weekdays as "1,2,3,4,5"
        .addColumn("weekdays", "varchar(20)", (c) => c.notNull())
        .addColumn("hour", "integer", (c) => c.notNull())
        // Calendar day (subscriber's time zone) of the last mail, "YYYY-MM-DD"
        .addColumn("last_sent_on", "varchar(10)")
        .addUniqueConstraint("uq_core_query_subscription", [
          "query_id",
          "user_id",
        ])
        .execute();
    },
  };
}
