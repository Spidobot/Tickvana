import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "./db/schema.js";
import { startTestApp, type TestApp } from "./testing.js";

describeEachDb<TrackDb>("dashboards", (t) => {
  let app: TestApp;
  let queryId: string;
  let group: string;

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    for (const name of ["mira", "gast"]) await app.addUser(name);
    queryId = (
      await app.call("POST", "/core/queries", "root", {
        name: "Offen",
        sql: "select count(*) as n from issues",
        visibility: "global",
      })
    ).json().id;
    group = (
      await app.call("POST", "/core/groups", "root", { name: "Team" })
    ).json().id;
    await app.call(
      "PUT",
      `/core/groups/${group}/members/${app.ids.mira}`,
      "root",
    );
    await app.call(
      "PUT",
      `/core/groups/${group}/members/${app.ids.root}`,
      "root",
    );
  }, 180_000);
  afterAll(() => app?.close());

  const names = async (who: string) =>
    (await app.call("GET", "/core/dashboards", who))
      .json()
      .map((d: { name: string }) => d.name);

  it("keeps widgets in order and shares like saved queries", async () => {
    const board = (
      await app.call("POST", "/core/dashboards", "root", {
        name: "Lage",
        visibility: "group",
        groupId: group,
      })
    ).json();
    const a = (
      await app.call("POST", `/core/dashboards/${board.id}/widgets`, "root", {
        queryId,
        view: "number",
        title: "Alle",
      })
    ).json();
    const b = (
      await app.call("POST", `/core/dashboards/${board.id}/widgets`, "root", {
        queryId,
        view: "table",
        width: 2,
      })
    ).json();
    await app.call("PATCH", `/core/dashboards/${board.id}`, "root", {
      order: [b.id, a.id],
    });
    const shown = (
      await app.call("GET", `/core/dashboards/${board.id}`, "mira")
    ).json();
    expect(shown.widgets.map((w: { id: string }) => w.id)).toEqual([
      b.id,
      a.id,
    ]);
    expect(shown.widgets[1]).toMatchObject({
      view: "number",
      title: "Alle",
      app: "tickvana",
    });
    expect(await names("mira")).toEqual(["Lage"]);
    expect(await names("gast")).toEqual([]);
    expect(
      (await app.call("GET", `/core/dashboards/${board.id}`, "gast"))
        .statusCode,
    ).toBe(404);
    // Members of the group see it, but only the owner changes it.
    expect(
      (
        await app.call("POST", `/core/dashboards/${board.id}/widgets`, "mira", {
          queryId,
        })
      ).statusCode,
    ).toBe(403);
  });

  it("keeps portal customers away from saved queries and dashboards", async () => {
    await app.addUser("kunde", { kind: "customer" });
    for (const path of ["/core/queries", "/core/dashboards"])
      expect((await app.call("GET", path, "kunde")).statusCode, path).toBe(403);
  });

  it("remembers each user's home dashboard", async () => {
    const board = (await app.call("GET", "/core/dashboards", "mira")).json()[0];
    expect(
      (
        await app.call("PUT", "/core/me/home-dashboard", "gast", {
          dashboardId: board.id,
        })
      ).statusCode,
    ).toBe(404);
    await app.call("PUT", "/core/me/home-dashboard", "mira", {
      dashboardId: board.id,
    });
    expect(
      (await app.call("GET", "/core/dashboards", "mira")).json()[0].home,
    ).toBe(true);
    expect(
      (await app.call("GET", "/core/dashboards", "root")).json()[0].home,
    ).toBe(false);
    await app.call("DELETE", `/core/dashboards/${board.id}`, "root");
    expect(await names("mira")).toEqual([]);
  });
});
