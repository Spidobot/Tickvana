import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import type { Dialect } from "../db/dialect.js";

/** When a notification went out by mail, or was decided not to. Null: still waiting for the digest. */
export function notificationMail({ types }: Dialect): Migration {
  return {
    async up(db: Kysely<never>) {
      await db.schema
        .alterTable("core_notification")
        .addColumn("mailed_at", types.timestamp)
        .execute();
      await db.schema
        .createIndex("idx_core_notification_mailed")
        .on("core_notification")
        .column("mailed_at")
        .execute();
    },
  };
}
