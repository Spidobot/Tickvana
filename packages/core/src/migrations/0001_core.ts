import type { ColumnDefinitionBuilder, Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import type { Dialect } from "../db/dialect.js";

const notNull = (c: ColumnDefinitionBuilder) => c.notNull();

/** All core_* tables. See CONCEPT.md §4. */
export function coreSchema({ types }: Dialect): Migration {
  const userRef = (c: ColumnDefinitionBuilder) =>
    c.notNull().references("core_user.id");

  return {
    async up(db: Kysely<never>) {
      const s = db.schema;

      await s
        .createTable("core_user")
        .addColumn("id", types.id, (c) => c.primaryKey())
        // Stored lower-cased by the application.
        .addColumn("email", "varchar(320)", (c) => c.notNull().unique())
        .addColumn("display_name", "varchar(200)", notNull)
        .addColumn("password_hash", "varchar(255)")
        .addColumn("kind", "varchar(20)", notNull) // internal | customer | service
        .addColumn("active", "boolean", notNull)
        .addColumn("locale", "varchar(10)", notNull)
        .addColumn("timezone", "varchar(64)", notNull)
        .addColumn("created_at", types.timestamp, notNull)
        .addColumn("updated_at", types.timestamp, notNull)
        .execute();

      await s
        .createTable("core_identity")
        .addColumn("provider", "varchar(100)", notNull)
        .addColumn("subject", "varchar(255)", notNull)
        .addColumn("user_id", types.id, userRef)
        .addColumn("created_at", types.timestamp, notNull)
        .addPrimaryKeyConstraint("pk_core_identity", ["provider", "subject"])
        .execute();
      await s
        .createIndex("idx_core_identity_user")
        .on("core_identity")
        .column("user_id")
        .execute();

      await s
        .createTable("core_group")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("name", "varchar(200)", (c) => c.notNull().unique())
        .addColumn("created_at", types.timestamp, notNull)
        .execute();

      await s
        .createTable("core_group_member")
        .addColumn("group_id", types.id, (c) =>
          c.notNull().references("core_group.id").onDelete("cascade"),
        )
        .addColumn("user_id", types.id, userRef)
        .addPrimaryKeyConstraint("pk_core_group_member", [
          "group_id",
          "user_id",
        ])
        .execute();
      await s
        .createIndex("idx_core_group_member_user")
        .on("core_group_member")
        .column("user_id")
        .execute();

      await s
        .createTable("core_session")
        // SHA-256 of the cookie value. The value itself is never stored.
        .addColumn("id_hash", "varchar(64)", (c) => c.primaryKey())
        .addColumn("user_id", types.id, userRef)
        .addColumn("expires_at", types.timestamp, notNull)
        .addColumn("created_at", types.timestamp, notNull)
        .execute();
      await s
        .createIndex("idx_core_session_user")
        .on("core_session")
        .column("user_id")
        .execute();
      await s
        .createIndex("idx_core_session_expires")
        .on("core_session")
        .column("expires_at")
        .execute();

      await s
        .createTable("core_api_token")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("token_hash", "varchar(64)", (c) => c.notNull().unique())
        .addColumn("user_id", types.id, userRef)
        .addColumn("name", "varchar(200)", notNull)
        .addColumn("expires_at", types.timestamp)
        .addColumn("last_used_at", types.timestamp)
        .addColumn("created_at", types.timestamp, notNull)
        .execute();
      await s
        .createIndex("idx_core_api_token_user")
        .on("core_api_token")
        .column("user_id")
        .execute();

      await s
        .createTable("core_setting")
        .addColumn("key", "varchar(200)", (c) => c.primaryKey())
        .addColumn("value_json", types.text, notNull)
        .addColumn("updated_at", types.timestamp, notNull)
        .execute();

      await s
        .createTable("core_attachment")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("owner_type", "varchar(50)", notNull)
        .addColumn("owner_id", types.id, notNull)
        .addColumn("filename", "varchar(500)", notNull)
        .addColumn("mime", "varchar(200)", notNull)
        // ponytail: 32 bit, caps a file at 2 GB. Switch to bigint if larger uploads are wanted.
        .addColumn("size", "integer", notNull)
        .addColumn("storage_key", "varchar(500)", notNull)
        .addColumn("created_by", types.id, userRef)
        .addColumn("created_at", types.timestamp, notNull)
        .execute();
      await s
        .createIndex("idx_core_attachment_owner")
        .on("core_attachment")
        .columns(["owner_type", "owner_id"])
        .execute();

      await s
        .createTable("core_event")
        // UUIDv7, so the primary key is also the processing order.
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("type", "varchar(100)", notNull)
        .addColumn("actor_id", types.id, (c) => c.references("core_user.id"))
        .addColumn("entity_type", "varchar(50)", notNull)
        .addColumn("entity_id", types.id, notNull)
        .addColumn("payload_json", types.text, notNull)
        .addColumn("created_at", types.timestamp, notNull)
        .execute();
      await s
        .createIndex("idx_core_event_entity")
        .on("core_event")
        .columns(["entity_type", "entity_id"])
        .execute();
      await s
        .createIndex("idx_core_event_actor")
        .on("core_event")
        .column("actor_id")
        .execute();

      await s
        .createTable("core_job")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("type", "varchar(100)", notNull)
        .addColumn("payload_json", types.text, notNull)
        .addColumn("run_at", types.timestamp, notNull)
        .addColumn("state", "varchar(20)", notNull) // pending | running | done | failed
        .addColumn("attempts", "integer", notNull)
        .addColumn("locked_by", "varchar(100)")
        .addColumn("locked_at", types.timestamp)
        .addColumn("last_error", types.text)
        .addColumn("created_at", types.timestamp, notNull)
        .execute();
      await s
        .createIndex("idx_core_job_due")
        .on("core_job")
        .columns(["state", "run_at"])
        .execute();

      await s
        .createTable("core_notification")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("user_id", types.id, userRef)
        .addColumn("event_id", types.id, (c) =>
          c.notNull().references("core_event.id").onDelete("cascade"),
        )
        .addColumn("read_at", types.timestamp)
        .addColumn("created_at", types.timestamp, notNull)
        .execute();
      await s
        .createIndex("idx_core_notification_user")
        .on("core_notification")
        .columns(["user_id", "read_at"])
        .execute();

      await s
        .createTable("core_webhook")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("url", "varchar(2000)", notNull)
        // Encrypted with SECRET_KEY.
        .addColumn("secret", types.text, notNull)
        .addColumn("event_filter_json", types.text, notNull)
        .addColumn("active", "boolean", notNull)
        .addColumn("created_at", types.timestamp, notNull)
        .execute();

      await s
        .createTable("core_saved_query")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("owner_id", types.id, userRef)
        .addColumn("name", "varchar(200)", notNull)
        .addColumn("sql", types.text, notNull)
        .addColumn("params_json", types.text, notNull)
        .addColumn("visibility", "varchar(20)", notNull) // private | group | global
        .addColumn("group_id", types.id, (c) => c.references("core_group.id"))
        .addColumn("created_at", types.timestamp, notNull)
        .addColumn("updated_at", types.timestamp, notNull)
        .execute();
      await s
        .createIndex("idx_core_saved_query_owner")
        .on("core_saved_query")
        .column("owner_id")
        .execute();

      await s
        .createTable("core_dashboard")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("owner_id", types.id, userRef)
        .addColumn("name", "varchar(200)", notNull)
        .addColumn("visibility", "varchar(20)", notNull)
        .addColumn("layout_json", types.text, notNull)
        .addColumn("created_at", types.timestamp, notNull)
        .addColumn("updated_at", types.timestamp, notNull)
        .execute();
      await s
        .createIndex("idx_core_dashboard_owner")
        .on("core_dashboard")
        .column("owner_id")
        .execute();

      await s
        .createTable("core_dashboard_widget")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("dashboard_id", types.id, (c) =>
          c.notNull().references("core_dashboard.id").onDelete("cascade"),
        )
        .addColumn("query_id", types.id, (c) =>
          c.notNull().references("core_saved_query.id"),
        )
        .addColumn("kind", "varchar(30)", notNull)
        .addColumn("config_json", types.text, notNull)
        .execute();
      await s
        .createIndex("idx_core_dashboard_widget_dashboard")
        .on("core_dashboard_widget")
        .column("dashboard_id")
        .execute();

      await s
        .createTable("core_link")
        .addColumn("from_type", "varchar(50)", notNull)
        .addColumn("from_id", types.id, notNull)
        .addColumn("to_type", "varchar(50)", notNull)
        .addColumn("to_id", types.id, notNull)
        .addColumn("kind", "varchar(30)", notNull)
        .addColumn("created_at", types.timestamp, notNull)
        .addPrimaryKeyConstraint("pk_core_link", [
          "from_type",
          "from_id",
          "to_type",
          "to_id",
          "kind",
        ])
        .execute();
      await s
        .createIndex("idx_core_link_to")
        .on("core_link")
        .columns(["to_type", "to_id"])
        .execute();
    },
  };
}
