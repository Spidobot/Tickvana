import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import type { Dialect } from "@tvn/core";

/** One unpublished draft per workflow, edited in the graphical editor. */
export function workflowDraft({ types }: Dialect): Migration {
  return {
    async up(db: Kysely<never>) {
      await db.schema
        .createTable("track_workflow_draft")
        .addColumn("workflow_id", types.id, (c) =>
          c.primaryKey().references("track_workflow.id").onDelete("cascade"),
        )
        .addColumn("definition_json", types.text, (c) => c.notNull())
        .addColumn("updated_by", types.id, (c) => c.notNull())
        .addColumn("updated_at", types.timestamp, (c) => c.notNull())
        .execute();
    },
  };
}
