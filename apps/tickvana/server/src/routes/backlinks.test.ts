import { describeEachDb } from "@tvn/core/testing";
import type { CoreDb } from "@tvn/core";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<TrackDb>("mentioned on pages", (t) => {
  let app: TestApp;
  let key: string;
  const link = (row: object) =>
    (app.db as unknown as Kysely<CoreDb>)
      .insertInto("core_link")
      .values({ kind: "mentions", created_at: new Date(), ...row } as never)
      .execute();

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    await app.addUser("fremd");
    for (const k of ["WIT", "OPS"])
      await app.call("POST", "/projects", "root", { key: k, name: k });
    const type = (
      await app.db
        .selectFrom("track_issue_type")
        .select("id")
        .executeTakeFirstOrThrow()
    ).id;
    key = (
      await app.call("POST", "/issues", "root", {
        projectKey: "WIT",
        type,
        fields: { summary: "Drucker" },
      })
    ).json().key;
  }, 180_000);
  afterAll(() => app?.close());

  it("lists pages that mention the ticket, also by a key from before a move", async () => {
    await link({
      from_type: "page",
      from_id: "p1",
      to_type: "issue",
      to_id: key,
    });
    await link({
      from_type: "issue",
      from_id: key,
      to_type: "page",
      to_id: "p2",
    });
    const moved = (
      await app.call("POST", `/issues/${key}/move`, "root", {
        projectKey: "OPS",
      })
    ).json().key;
    expect(moved).toMatch(/^OPS-/);
    await link({
      from_type: "page",
      from_id: "p3",
      to_type: "issue",
      to_id: moved,
    });
    const res = await app.call("GET", `/issues/${moved}/pages`, "root");
    expect(res.json().pageIds.sort()).toEqual(["p1", "p2", "p3"]);
    // The old key still opens the ticket, for blocks written before the move.
    expect((await app.call("GET", `/issues/${key}`, "root")).json().key).toBe(
      moved,
    );
    expect(
      (await app.call("GET", `/issues/${moved}/pages`, "fremd")).statusCode,
    ).toBe(404);
  });
});
