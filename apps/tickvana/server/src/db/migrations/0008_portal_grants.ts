import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { uuidv7 } from "@tvn/core";
import type { TrackDb } from "../schema.js";
import { DEFAULTS_SETTING } from "./0002_seed.js";

/**
 * Customers may use the portal in the standard scheme. That only reaches
 * projects they are customers of, so it is safe for every project.
 */
export function portalGrants(): Migration {
  return {
    async up(raw: Kysely<never>) {
      const db = raw as unknown as Kysely<TrackDb>;
      const row = await db
        .selectFrom("core_setting")
        .select("value_json")
        .where("key", "=", DEFAULTS_SETTING)
        .executeTakeFirst();
      if (!row) return;
      const { permissionSchemeId } = JSON.parse(row.value_json) as {
        permissionSchemeId: string;
      };
      await db
        .insertInto("track_permission_grant")
        .values(
          [
            "project.browse",
            "issue.create",
            "issue.comment",
            "issue.attach",
          ].map((permission) => ({
            id: uuidv7(),
            scheme_id: permissionSchemeId,
            permission,
            grantee_type: "customer" as const,
            grantee_id: null,
          })),
        )
        .execute();
    },
  };
}
