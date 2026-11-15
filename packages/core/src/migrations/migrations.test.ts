import { expect, it } from "vitest";
import { uuidv7 } from "../db/index.js";
import type { CoreDb } from "../schema.js";
import { describeEachDb } from "../testing/index.js";
import { migrateCore } from "./index.js";

describeEachDb<CoreDb>("core schema", (t) => {
  it("has the same tables, columns and nullability on every database", async () => {
    await migrateCore(t);
    const tables = await t.db.introspection.getTables();
    const shape = Object.fromEntries(
      tables
        .filter((table) => !table.name.includes("_migration"))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((table) => [
          table.name,
          table.columns
            .map((c) => `${c.name}${c.isNullable ? "?" : ""}`)
            .sort(),
        ]),
    );
    // One snapshot file for all databases: a vendor that drifts fails here.
    await expect(JSON.stringify(shape, null, 2) + "\n").toMatchFileSnapshot(
      "./core-schema.snap.json",
    );
  });

  it("round-trips booleans, dates and nulls", async () => {
    const now = new Date("2026-03-04T05:06:07.123Z");
    const id = uuidv7();
    await t.db
      .insertInto("core_user")
      .values({
        id,
        email: "ada@example.org",
        display_name: "Ada",
        password_hash: null,
        kind: "internal",
        active: true,
        locale: "de",
        timezone: "Europe/Vienna",
        created_at: now,
        updated_at: now,
      })
      .execute();
    const user = await t.db
      .selectFrom("core_user")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(user.active).toBe(true);
    expect(user.password_hash).toBeNull();
    expect(user.created_at.toISOString()).toBe(now.toISOString());
  });

  it("enforces foreign keys and unique e-mail", async () => {
    const now = new Date();
    await expect(
      t.db
        .insertInto("core_session")
        .values({
          id_hash: "x",
          user_id: uuidv7(),
          expires_at: now,
          created_at: now,
        })
        .execute(),
    ).rejects.toThrow();
    await expect(
      t.db
        .insertInto("core_user")
        .values({
          id: uuidv7(),
          email: "ada@example.org",
          display_name: "Ada 2",
          password_hash: null,
          kind: "internal",
          active: false,
          locale: "de",
          timezone: "UTC",
          created_at: now,
          updated_at: now,
        })
        .execute(),
    ).rejects.toThrow();
  });
});
