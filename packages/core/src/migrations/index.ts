import type { MigrationResult } from "kysely/migration";
import { migrate, type Database } from "../db/index.js";
import { coreSchema } from "./0001_core.js";
import { globalGrant } from "./0002_global_grant.js";
import { notificationMail } from "./0003_notification_mail.js";
import { querySubscription } from "./0004_query_subscription.js";
import { webhookDelivery } from "./0005_webhook_delivery.js";
import { dashboardSharing } from "./0006_dashboard.js";

/** Brings the core_* tables up to date. Both apps call this on start. */
export function migrateCore<DB>({
  db,
  dialect,
}: Database<DB>): Promise<MigrationResult[]> {
  return migrate(db, "core", {
    "0001_core": coreSchema(dialect),
    "0002_global_grant": globalGrant(dialect),
    "0003_notification_mail": notificationMail(dialect),
    "0004_query_subscription": querySubscription(dialect),
    "0005_webhook_delivery": webhookDelivery(dialect),
    "0006_dashboard": dashboardSharing(dialect),
  });
}
