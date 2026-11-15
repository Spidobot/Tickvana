import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import type { Dialect } from "../db/dialect.js";

/** Dashboards shared with a group, and each user's home dashboard. */
export function dashboardSharing({ types }: Dialect): Migration {
  return {
    async up(db: Kysely<never>) {
      await db.schema
        .alterTable("core_dashboard")
        .addColumn("group_id", types.id)
        .execute();
      await db.schema
        .createTable("core_home_dashboard")
        .addColumn("user_id", types.id, (c) =>
          c.primaryKey().references("core_user.id").onDelete("cascade"),
        )
        .addColumn("dashboard_id", types.id, (c) =>
          c.notNull().references("core_dashboard.id").onDelete("cascade"),
        )
        .execute();
    },
  };
}
