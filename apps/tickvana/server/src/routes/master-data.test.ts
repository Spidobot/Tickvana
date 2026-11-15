import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<TrackDb>("master data", (t) => {
  let app: TestApp;
  const meta = async () => (await app.call("GET", "/meta", "root")).json();

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    await app.addUser("mira");
  }, 180_000);
  afterAll(() => app?.close());

  it("lets only system administrators change master data", async () => {
    expect(
      (
        await app.call("POST", "/admin/resolutions", "mira", {
          name: "Doppelt",
        })
      ).statusCode,
    ).toBe(403);
    const made = await app.call("POST", "/admin/resolutions", "root", {
      name: "Doppelt",
    });
    expect(made.statusCode).toBe(201);
    expect((await meta()).resolutions).toContainEqual(made.json());
    expect(
      (
        await app.call("POST", "/admin/resolutions", "root", {
          name: "doppelt",
        })
      ).statusCode,
    ).toBe(409);
  });

  it("validates each kind and changes single values", async () => {
    expect(
      (
        await app.call("POST", "/admin/priorities", "root", {
          name: "Sofort",
          color: "red",
          position: 0,
        })
      ).statusCode,
    ).toBe(400);
    const p = (
      await app.call("POST", "/admin/priorities", "root", {
        name: "Sofort",
        color: "#ff0000",
        position: 9,
      })
    ).json();
    const changed = await app.call(
      "PATCH",
      `/admin/priorities/${p.id}`,
      "root",
      {
        color: "#00ff00",
      },
    );
    expect(changed.json()).toEqual({ ...p, color: "#00ff00" });
    const status = (
      await app.call("POST", "/admin/statuses", "root", {
        name: "Wartet",
        category: "in_progress",
      })
    ).json();
    expect((await meta()).statuses).toContainEqual(status);
    const link = await app.call("POST", "/admin/link-types", "root", {
      name: "Ersetzt",
      outward: "ersetzt",
      inward: "wird ersetzt von",
    });
    expect(link.statusCode).toBe(201);
    const type = await app.call("POST", "/admin/issue-types", "root", {
      name: "Störung",
      icon: "siren",
      level: 0,
    });
    expect(type.statusCode).toBe(201);
  });

  it("refuses to delete what is still in use", async () => {
    const m = await meta();
    const task = m.issueTypes.find((x: { name: string }) => x.name === "Task");
    const todo = m.statuses.find((x: { name: string }) => x.name === "To Do");
    const medium = m.priorities.find(
      (x: { name: string }) => x.name === "Medium",
    );
    await app.call("POST", "/projects", "root", { key: "WIT", name: "WIT" });
    await app.call("POST", "/issues", "root", {
      projectKey: "WIT",
      type: task.id,
      fields: { summary: "x" },
    });
    for (const [kind, id] of [
      ["issue-types", task.id],
      ["statuses", todo.id],
      ["priorities", medium.id],
    ])
      expect(
        (await app.call("DELETE", `/admin/${kind}/${id}`, "root")).statusCode,
      ).toBe(409);
    const unused = m.resolutions.find(
      (x: { name: string }) => x.name === "Doppelt",
    );
    expect(
      (await app.call("DELETE", `/admin/resolutions/${unused.id}`, "root"))
        .statusCode,
    ).toBe(204);
    expect(
      (await app.call("DELETE", `/admin/resolutions/${unused.id}`, "root"))
        .statusCode,
    ).toBe(404);
  });
});
