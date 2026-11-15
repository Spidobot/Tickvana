import { migrate, type Database } from "@tvn/core";
import type { MigrationResult } from "kysely/migration";
import { trackSchema } from "./0001_schema.js";
import { trackSeed } from "./0002_seed.js";
import { bulkOperation } from "./0003_bulk.js";
import { boardProject } from "./0004_board_project.js";
import { automationCaused } from "./0005_automation_caused.js";
import { workflowDraft } from "./0006_workflow_draft.js";
import { serviceDesk } from "./0007_service_desk.js";
import { portalGrants } from "./0008_portal_grants.js";
import { satisfactionField } from "./0009_satisfaction.js";

/** Brings the track_* tables up to date. Runs after the core migrations. */
export function migrateTrack<DB>({
  db,
  dialect,
}: Database<DB>): Promise<MigrationResult[]> {
  return migrate(db, "track", {
    "0001_schema": trackSchema(dialect),
    "0002_seed": trackSeed,
    "0003_bulk": bulkOperation(dialect),
    "0004_board_project": boardProject(dialect),
    "0005_automation_caused": automationCaused(dialect),
    "0006_workflow_draft": workflowDraft(dialect),
    "0007_service_desk": serviceDesk(dialect),
    "0008_portal_grants": portalGrants(),
    "0009_satisfaction": satisfactionField(),
  });
}
