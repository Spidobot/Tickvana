import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<TrackDb>("bulk changes", (t) => {
  let app: TestApp;
  let task: string;
  const status: Record<string, string> = {};
  const keys: string[] = [];

  /** Runs queued jobs until the operation is finished. */
  const drain = async () => {
    while ((await app.running.queue.runDue()) > 0);
  };
  const start = async (as: string, body: object) => {
    const res = await app.call("POST", "/bulk", as, body);
    await drain();
    return res;
  };
  const progress = async (as: string, id: string) =>
    (await app.call("GET", `/bulk/${id}`, as)).json();

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    for (const name of ["mira", "gast"]) await app.addUser(name);
    await app.call("POST", "/projects", "root", {
      key: "WIT",
      name: "Werkstatt-IT",
    });
    await app.call("POST", "/projects", "root", { key: "GEH", name: "Geheim" });
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
    for (const s of await app.db
      .selectFrom("track_status")
      .selectAll()
      .execute())
      status[s.category] = s.id;
    // 60 tickets: more than two batches.
    for (let i = 0; i < 60; i++) {
      keys.push(
        (
          await app.call("POST", "/issues", "mira", {
            projectKey: "WIT",
            type: task,
            fields: { summary: `Ticket ${i}` },
          })
        ).json().key,
      );
    }
    keys.push(
      (
        await app.call("POST", "/issues", "root", {
          projectKey: "GEH",
          type: task,
          fields: { summary: "Geheim" },
        })
      ).json().key,
    );
  }, 180_000);
  afterAll(() => app?.close());

  it("edits many tickets in batches and records each change", async () => {
    const res = await start("mira", {
      keys,
      action: { kind: "edit", fields: { labels: ["sammel"] } },
    });
    expect(res.statusCode).toBe(202);
    const op = await progress("mira", res.json().id);
    expect(op).toMatchObject({ state: "finished", total: 61, done: 61 });
    // The ticket in the other project is not mira's to change: one error, the rest done.
    expect(op.errors).toEqual([{ key: "GEH-1", message: "Not found" }]);

    const labelled = await app.db
      .selectFrom("track_issue_label")
      .select("issue_id")
      .where("label", "=", "sammel")
      .execute();
    expect(labelled).toHaveLength(60);
    const history = await app.db
      .selectFrom("track_issue_change_item")
      .select("field_key")
      .where("field_key", "=", "labels")
      .execute();
    expect(history).toHaveLength(60);
    // Only the starter sees the progress.
    expect(
      (await app.call("GET", `/bulk/${res.json().id}`, "gast")).statusCode,
    ).toBe(404);
  });

  it("transitions by target status and deletes", async () => {
    const some = keys.slice(0, 5);
    const done = await start("mira", {
      keys: some,
      action: { kind: "transition", toStatusId: status.done },
    });
    expect(await progress("mira", done.json().id)).toMatchObject({
      state: "finished",
      done: 5,
      errors: [],
    });
    const statuses = await app.db
      .selectFrom("track_issue")
      .select("status_id")
      .where("key", "in", some)
      .execute();
    expect(statuses.every((s) => s.status_id === status.done)).toBe(true);

    // Done → Done is not a transition.
    const again = await start("mira", {
      keys: some.slice(0, 1),
      action: { kind: "transition", toStatusId: status.done },
    });
    expect((await progress("mira", again.json().id)).errors).toHaveLength(1);

    // Viewers may not delete: every ticket fails, nothing is gone.
    const denied = await start("gast", {
      keys: some,
      action: { kind: "delete" },
    });
    expect((await progress("gast", denied.json().id)).errors).toHaveLength(5);
    const removed = await start("root", {
      keys: some,
      action: { kind: "delete" },
    });
    expect(await progress("root", removed.json().id)).toMatchObject({
      done: 5,
      errors: [],
    });
    expect(
      await app.db
        .selectFrom("track_issue")
        .select("id")
        .where("key", "in", some)
        .execute(),
    ).toEqual([]);
  });

  it("validates the request", async () => {
    expect(
      (
        await app.call("POST", "/bulk", "mira", {
          keys: [],
          action: { kind: "delete" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.call("POST", "/bulk", "mira", {
          keys: ["WIT-6"],
          action: { kind: "edit", fields: {} },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.call("POST", "/bulk", "mira", {
          keys: ["WIT-6"],
          action: { kind: "rename" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.call("POST", "/bulk", null, {
          keys: ["WIT-6"],
          action: { kind: "delete" },
        })
      ).statusCode,
    ).toBe(401);
  });
});
