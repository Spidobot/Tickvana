import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import type { Dialect } from "@tvn/core";

/** Events that an automation caused. They trigger no further rules, so rules cannot loop. */
export function automationCaused({ types }: Dialect): Migration {
  return {
    async up(db: Kysely<never>) {
      await db.schema
        .createTable("track_automation_caused")
        .addColumn("event_id", types.id, (c) => c.primaryKey())
        .addColumn("run_id", types.id, (c) =>
          c.notNull().references("track_automation_run.id").onDelete("cascade"),
        )
        .execute();
    },
  };
}
