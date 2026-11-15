import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import type { Dialect } from "../db/dialect.js";

/** One attempt to deliver an event to a webhook, for the delivery log. */
export function webhookDelivery({ types }: Dialect): Migration {
  return {
    async up(db: Kysely<never>) {
      await db.schema
        .createTable("core_webhook_delivery")
        .addColumn("id", types.id, (c) => c.primaryKey())
        .addColumn("webhook_id", types.id, (c) =>
          c.notNull().references("core_webhook.id").onDelete("cascade"),
        )
        .addColumn("event_id", types.id, (c) => c.notNull())
        .addColumn("event_type", "varchar(100)", (c) => c.notNull())
        .addColumn("attempt", "integer", (c) => c.notNull())
        .addColumn("status_code", "integer")
        .addColumn("error", types.text)
        .addColumn("duration_ms", "integer", (c) => c.notNull())
        .addColumn("created_at", types.timestamp, (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex("idx_core_webhook_delivery_hook")
        .on("core_webhook_delivery")
        .columns(["webhook_id", "created_at"])
        .execute();
      await db.schema
        .alterTable("core_webhook")
        .addColumn("name", "varchar(200)")
        .execute();
    },
  };
}
