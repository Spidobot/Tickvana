import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { uuidv7 } from "@tvn/core";
import type { TrackDb } from "../schema.js";

/** The rating customers give a finished request: a number field, 1 to 5, reportable like any field. */
export function satisfactionField(): Migration {
  return {
    async up(raw: Kysely<never>) {
      const db = raw as unknown as Kysely<TrackDb>;
      const taken = await db
        .selectFrom("track_field")
        .select("id")
        .where("key", "=", "satisfaction")
        .executeTakeFirst();
      if (taken) return;
      await db
        .insertInto("track_field")
        .values({
          id: uuidv7(),
          key: "satisfaction",
          name: "Satisfaction",
          type: "number",
          is_system: false,
          config_json: JSON.stringify({ min: 1, max: 5 }),
        })
        .execute();
    },
  };
}
