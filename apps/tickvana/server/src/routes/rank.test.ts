import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<TrackDb>("manual order", (t) => {
  let app: TestApp;
  let task: string;

  const order = async () =>
    (await app.call("GET", "/projects/WIT/issues?limit=200", "mira"))
      .json()
      .map((i: { key: string }) => i.key);
  const move = (key: string, body: object, as = "mira") =>
    app.call("POST", `/issues/${key}/rank`, as, body);

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    for (const name of ["mira", "gast"]) await app.addUser(name);
    await app.call("POST", "/projects", "root", {
      key: "WIT",
      name: "Werkstatt-IT",
    });
    const roles = Object.fromEntries(
      (await app.db.selectFrom("track_project_role").selectAll().execute()).map(
        (r) => [r.name, r.id],
      ),
    );
    await app.call("PUT", "/projects/WIT/members", "root", {
      roleId: roles.Members,
      principalType: "user",
      principalId: app.ids.mira,
    });
    await app.call("PUT", "/projects/WIT/members", "root", {
      roleId: roles.Viewers,
      principalType: "user",
      principalId: app.ids.gast,
    });
    task = (
      await app.db
        .selectFrom("track_issue_type")
        .select("id")
        .where("name", "=", "Task")
        .executeTakeFirstOrThrow()
    ).id;
    for (let i = 1; i <= 5; i++)
      await app.call("POST", "/issues", "mira", {
        projectKey: "WIT",
        type: task,
        fields: { summary: `T${i}` },
      });
  }, 180_000);
  afterAll(() => app?.close());

  it("puts new tickets at the end", async () => {
    expect(await order()).toEqual([
      "WIT-1",
      "WIT-2",
      "WIT-3",
      "WIT-4",
      "WIT-5",
    ]);
  });

  it("moves a ticket between neighbours, to the top and to the bottom", async () => {
    expect(
      (await move("WIT-5", { afterKey: "WIT-1", beforeKey: "WIT-2" }))
        .statusCode,
    ).toBe(200);
    expect(await order()).toEqual([
      "WIT-1",
      "WIT-5",
      "WIT-2",
      "WIT-3",
      "WIT-4",
    ]);
    await move("WIT-4", { beforeKey: "WIT-1" });
    expect(await order()).toEqual([
      "WIT-4",
      "WIT-1",
      "WIT-5",
      "WIT-2",
      "WIT-3",
    ]);
    await move("WIT-4", { afterKey: "WIT-3" });
    expect(await order()).toEqual([
      "WIT-1",
      "WIT-5",
      "WIT-2",
      "WIT-3",
      "WIT-4",
    ]);
    // A ticket moved earlier keeps its place when new ones arrive.
    await app.call("POST", "/issues", "mira", {
      projectKey: "WIT",
      type: task,
      fields: { summary: "T6" },
    });
    expect(await order()).toEqual([
      "WIT-1",
      "WIT-5",
      "WIT-2",
      "WIT-3",
      "WIT-4",
      "WIT-6",
    ]);
  });

  it("keeps order through many moves into one gap, rebalancing when needed", async () => {
    // Keep pushing the last ticket right after WIT-1: the gap halves every time.
    for (let i = 0; i < 300; i++) {
      const last = (await order()).at(-1)!;
      const res = await move(last, {
        afterKey: "WIT-1",
        beforeKey: (await order())[1],
      });
      expect(res.statusCode).toBe(200);
    }
    const ranks = await app.db
      .selectFrom("track_issue")
      .select("rank")
      .execute();
    expect(Math.max(...ranks.map((r) => r.rank.length))).toBeLessThanOrEqual(
      48,
    );
    expect(new Set(await order()).size).toBe(6);
    expect((await order())[0]).toBe("WIT-1");
  }, 180_000);

  it("refuses stale or invalid moves and people who may not edit", async () => {
    expect(
      (await move("WIT-2", { afterKey: "WIT-3", beforeKey: "WIT-1" }))
        .statusCode,
    ).toBe(409);
    expect((await move("WIT-2", {})).statusCode).toBe(400);
    expect((await move("WIT-2", { afterKey: "WIT-2" })).statusCode).toBe(400);
    expect((await move("WIT-2", { afterKey: "WIT-99" })).statusCode).toBe(404);
    expect(
      (await move("WIT-2", { afterKey: "WIT-1" }, "gast")).statusCode,
    ).toBe(403);
  });
});
