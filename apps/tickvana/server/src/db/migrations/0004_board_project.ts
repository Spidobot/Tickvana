import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import type { Dialect } from "@tvn/core";

/** A board belongs to a project: its administrators manage it. */
export function boardProject({ types }: Dialect): Migration {
  return {
    async up(db: Kysely<never>) {
      await db.schema
        .alterTable("track_board")
        .addColumn("project_id", types.id, (c) =>
          c.references("track_project.id").onDelete("cascade"),
        )
        .execute();
      await db.schema
        .createIndex("idx_track_board_project")
        .on("track_board")
        .column("project_id")
        .execute();
    },
  };
}
