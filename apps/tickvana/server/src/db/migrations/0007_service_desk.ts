import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import type { Dialect } from "@tvn/core";

/** Service desk tables, CONCEPT.md §3 "Service-Desk". */
export function serviceDesk({ types }: Dialect): Migration {
  return {
    async up(db: Kysely<never>) {
      const s = db.schema;
      await s
        .createTable("track_request_type")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("project_id", types.id, (c) =>
          c.notNull().references("track_project.id").onDelete("cascade"),
        )
        .addColumn("issue_type_id", types.id, (c) =>
          c.notNull().references("track_issue_type.id"),
        )
        .addColumn("name", "varchar(200)", (c) => c.notNull())
        .addColumn("description", "varchar(2000)", (c) =>
          c.notNull().defaultTo(""),
        )
        .addColumn("icon", "varchar(40)", (c) => c.notNull())
        .addColumn("group_name", "varchar(100)", (c) =>
          c.notNull().defaultTo(""),
        )
        .addColumn("field_layout_id", types.id, (c) =>
          c.notNull().references("track_field_layout.id"),
        )
        /** Values the portal does not ask for, as field key → value. */
        .addColumn("defaults_json", types.text, (c) => c.notNull())
        .addColumn("position", "integer", (c) => c.notNull())
        .execute();
      await s
        .createTable("track_organization")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("name", "varchar(200)", (c) => c.notNull().unique())
        .execute();
      await s
        .createTable("track_organization_member")
        .addColumn("organization_id", types.id, (c) =>
          c.notNull().references("track_organization.id").onDelete("cascade"),
        )
        .addColumn("user_id", types.id, (c) =>
          c.notNull().references("core_user.id").onDelete("cascade"),
        )
        .addPrimaryKeyConstraint("track_organization_member_pk", [
          "organization_id",
          "user_id",
        ])
        .execute();
      await s
        .createTable("track_project_customer")
        .addColumn("project_id", types.id, (c) =>
          c.notNull().references("track_project.id").onDelete("cascade"),
        )
        .addColumn("principal_type", "varchar(20)", (c) => c.notNull())
        .addColumn("principal_id", types.id, (c) => c.notNull())
        .addPrimaryKeyConstraint("track_project_customer_pk", [
          "project_id",
          "principal_type",
          "principal_id",
        ])
        .execute();
      await s
        .createTable("track_queue")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("project_id", types.id, (c) =>
          c.notNull().references("track_project.id").onDelete("cascade"),
        )
        .addColumn("name", "varchar(200)", (c) => c.notNull())
        .addColumn("query_id", types.id, (c) =>
          c.notNull().references("core_saved_query.id").onDelete("cascade"),
        )
        .addColumn("position", "integer", (c) => c.notNull())
        .execute();
      await s
        .createTable("track_calendar")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("name", "varchar(200)", (c) => c.notNull())
        .addColumn("timezone", "varchar(64)", (c) => c.notNull())
        .addColumn("hours_json", types.text, (c) => c.notNull())
        .addColumn("holidays_json", types.text, (c) => c.notNull())
        .execute();
      await s
        .createTable("track_sla_policy")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("project_id", types.id, (c) =>
          c.notNull().references("track_project.id").onDelete("cascade"),
        )
        .addColumn("name", "varchar(200)", (c) => c.notNull())
        .addColumn("calendar_id", types.id, (c) =>
          c.notNull().references("track_calendar.id"),
        )
        .addColumn("start_json", types.text, (c) => c.notNull())
        .addColumn("pause_json", types.text, (c) => c.notNull())
        .addColumn("stop_json", types.text, (c) => c.notNull())
        .addColumn("goals_json", types.text, (c) => c.notNull())
        .execute();
      await s
        .createTable("track_sla_cycle")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("issue_id", types.id, (c) =>
          c.notNull().references("track_issue.id").onDelete("cascade"),
        )
        .addColumn("policy_id", types.id, (c) =>
          c.notNull().references("track_sla_policy.id").onDelete("cascade"),
        )
        .addColumn("started_at", types.timestamp, (c) => c.notNull())
        .addColumn("paused_ms", "bigint", (c) => c.notNull().defaultTo(0))
        /** Set while the clock is paused. */
        .addColumn("paused_at", types.timestamp)
        .addColumn("due_at", types.timestamp, (c) => c.notNull())
        .addColumn("stopped_at", types.timestamp)
        .addColumn("breached", "boolean", (c) => c.notNull().defaultTo(false))
        .execute();
      await s
        .createIndex("track_sla_cycle_issue")
        .on("track_sla_cycle")
        .column("issue_id")
        .execute();
      await s
        .createTable("track_approval")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("issue_id", types.id, (c) =>
          c.notNull().references("track_issue.id").onDelete("cascade"),
        )
        .addColumn("approver_id", types.id, (c) =>
          c.notNull().references("core_user.id"),
        )
        .addColumn("decision", "varchar(20)")
        .addColumn("decided_at", types.timestamp)
        .execute();
      await s
        .createTable("track_canned_response")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("project_id", types.id, (c) =>
          c.references("track_project.id").onDelete("cascade"),
        )
        .addColumn("name", "varchar(200)", (c) => c.notNull())
        .addColumn("body_json", types.text, (c) => c.notNull())
        .execute();
      await s
        .createTable("track_mail_channel")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("project_id", types.id, (c) =>
          c.notNull().references("track_project.id").onDelete("cascade"),
        )
        .addColumn("request_type_id", types.id, (c) =>
          c.notNull().references("track_request_type.id").onDelete("cascade"),
        )
        /** Host, port, user, encrypted password, folder. */
        .addColumn("imap_json", types.text, (c) => c.notNull())
        .addColumn("active", "boolean", (c) => c.notNull())
        .execute();
      await s
        .alterTable("track_issue")
        .addColumn("request_type_id", types.id, (c) =>
          c.references("track_request_type.id").onDelete("set null"),
        )
        .execute();
    },
  };
}
