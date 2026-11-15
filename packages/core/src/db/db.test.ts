import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { describeEachDb } from "../testing/index.js";
import { createDb, likeCi, migrate, uuidv7 } from "./index.js";

describe("uuidv7", () => {
  it("is a v7 uuid and sorts by creation order", () => {
    const ids = Array.from({ length: 5000 }, uuidv7);
    expect(ids[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

it("rejects unknown database schemes", () => {
  expect(() => createDb("sqlite://x")).toThrow(/Unsupported/);
});

interface TestDb {
  f2_item: { id: string; name: string; grp: string; created_at: Date };
}

describeEachDb<TestDb>("database layer", (t) => {
  const migrations = (): Record<string, Migration> => ({
    "0001_item": {
      async up(k) {
        await k.schema
          .createTable("f2_item")
          .addColumn("id", t.dialect.types.id, (c) => c.primaryKey())
          .addColumn("name", t.dialect.types.text, (c) => c.notNull())
          .addColumn("grp", "varchar(10)", (c) => c.notNull())
          .addColumn("created_at", t.dialect.types.timestamp, (c) =>
            c.notNull(),
          )
          .execute();
        // A second run of this migration would insert a second row.
        await k
          .insertInto("f2_item")
          .values({
            id: uuidv7(),
            name: "Seed",
            grp: "a",
            created_at: new Date(),
          })
          .execute();
      },
    },
  });

  it("migrates once when two processes start together", async () => {
    const other = createDb<TestDb>(t.url);
    try {
      const runs = await Promise.all([
        migrate(t.db, "f2test", migrations()),
        migrate(other.db, "f2test", migrations()),
      ]);
      expect(runs.flat().filter((r) => r.status === "Success")).toHaveLength(1);
    } finally {
      await other.db.destroy();
    }
    const rows = await t.db.selectFrom("f2_item").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(await migrate(t.db, "f2test", migrations())).toEqual([]);
  });

  it("stores timestamps as UTC", async () => {
    const at = new Date("2026-01-02T03:04:05.678Z");
    const id = uuidv7();
    await t.db
      .insertInto("f2_item")
      .values({ id, name: "Zeit", grp: "a", created_at: at })
      .execute();
    const row = await t.db
      .selectFrom("f2_item")
      .select("created_at")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(new Date(row.created_at).toISOString()).toBe(at.toISOString());
  });

  it("matches case-insensitively", async () => {
    await t.db
      .insertInto("f2_item")
      .values({
        id: uuidv7(),
        name: "Größe ÄNDERN",
        grp: "b",
        created_at: new Date(),
      })
      .execute();
    const hit = await t.db
      .selectFrom("f2_item")
      .select("name")
      .where((eb) => likeCi(eb.ref("name"), "%größe ändern%"))
      .execute();
    expect(hit).toHaveLength(1);
  });

  it("aggregates strings", async () => {
    const rows = await t.db
      .selectFrom("f2_item")
      .select((eb) => [
        "grp",
        t.dialect.stringAgg(eb.ref("grp"), "|").as("joined"),
      ])
      .where("grp", "=", "a")
      .groupBy("grp")
      .execute();
    expect(rows).toEqual([{ grp: "a", joined: "a|a" }]);
  });

  it("aborts statements that exceed the timeout and leaves the pool usable", async () => {
    const slow =
      t.dialect.name === "postgres"
        ? sql`select pg_sleep(3)`
        : sql`select sleep(3)`;
    const started = Date.now();
    const result = await t.dialect
      .withStatementTimeout(t.db, 300, (trx) => slow.execute(trx))
      .then(
        (r) => r.rows,
        (e: unknown) => e,
      );
    expect(Date.now() - started).toBeLessThan(2500);
    expect(result).toBeInstanceOf(Error);

    const fast = await t.dialect.withStatementTimeout(t.db, 300, (trx) =>
      trx.selectFrom("f2_item").select("id").execute(),
    );
    expect(fast.length).toBeGreaterThan(0);
  });
});
