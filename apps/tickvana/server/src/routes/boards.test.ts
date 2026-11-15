import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<TrackDb>("boards", (t) => {
  let app: TestApp;
  let board: string;
  const status: Record<string, string> = {};

  const cards = async (as: string) =>
    (await app.call("GET", `/boards/${board}/cards`, as)).json();
  const keysIn = async (as: string) =>
    (await cards(as)).columns.map((c: { cards: { key: string }[] }) =>
      c.cards.map((k) => k.key),
    );

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    for (const name of ["lead", "mira", "gast", "fremd"])
      await app.addUser(name);
    await app.call("POST", "/projects", "root", {
      key: "WIT",
      name: "Werkstatt-IT",
      leadId: app.ids.lead,
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
    for (const s of await app.db
      .selectFrom("track_status")
      .selectAll()
      .execute())
      status[s.category] = s.id;
    const task = (
      await app.db
        .selectFrom("track_issue_type")
        .select("id")
        .where("name", "=", "Task")
        .executeTakeFirstOrThrow()
    ).id;
    for (const summary of ["Drucker", "Scanner", "WLAN", "Monitor"]) {
      await app.call("POST", "/issues", "mira", {
        projectKey: "WIT",
        type: task,
        fields: { summary },
      });
    }
    // One ticket behind a security level only its reporter (mira) passes.
    const wit = (
      await app.db
        .selectFrom("track_project")
        .select("id")
        .where("key", "=", "WIT")
        .executeTakeFirstOrThrow()
    ).id;
    await app.db
      .insertInto("track_security_level")
      .values({ id: "lvl", project_id: wit, name: "Personal" })
      .execute();
    await app.db
      .insertInto("track_security_level_member")
      .values({
        id: "m",
        level_id: "lvl",
        grantee_type: "reporter",
        grantee_id: null,
      })
      .execute();
    await app.call("POST", "/issues", "mira", {
      projectKey: "WIT",
      type: task,
      fields: { summary: "Vertraulich", securityLevel: "lvl" },
    });
  }, 180_000);
  afterAll(() => app?.close());

  it("lets project administrators create a board with a column per status", async () => {
    expect(
      (await app.call("POST", "/projects/WIT/boards", "mira", { name: "Team" }))
        .statusCode,
    ).toBe(403);
    const made = await app.call("POST", "/projects/WIT/boards", "lead", {
      name: "Team",
    });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({
      name: "Team",
      kind: "kanban",
      projectKey: "WIT",
      swimlanes: { by: "none" },
    });
    expect(made.json().columns.map((c: { name: string }) => c.name)).toEqual([
      "To Do",
      "In Progress",
      "Done",
    ]);
    board = made.json().id;
    expect(
      (await app.call("GET", "/projects/WIT/boards", "gast")).json(),
    ).toHaveLength(1);
  });

  it("shows each viewer only the cards they may see", async () => {
    expect(await keysIn("mira")).toEqual([
      ["WIT-1", "WIT-2", "WIT-3", "WIT-4", "WIT-5"],
      [],
      [],
    ]);
    expect(await keysIn("gast")).toEqual([
      ["WIT-1", "WIT-2", "WIT-3", "WIT-4"],
      [],
      [],
    ]);
    // The board's query is shared, but fremd sees no tickets in it.
    expect(await keysIn("fremd")).toEqual([[], [], []]);
    expect(
      (await app.call("GET", `/boards/${board}/cards`, null)).statusCode,
    ).toBe(401);
  });

  it("moves a card into a column by running the transition, and orders it", async () => {
    const move = (as: string, body: object) =>
      app.call("POST", `/boards/${board}/move`, as, body);
    const res = await move("mira", { key: "WIT-3", column: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json().statusId).toBe(status.in_progress);
    await move("mira", { key: "WIT-1", column: 1, afterKey: "WIT-3" });
    expect((await keysIn("mira"))[1]).toEqual(["WIT-3", "WIT-1"]);
    await move("mira", { key: "WIT-1", column: 1, beforeKey: "WIT-3" });
    expect((await keysIn("mira"))[1]).toEqual(["WIT-1", "WIT-3"]);
    // Reordering inside the To Do column, no transition.
    await move("mira", { key: "WIT-4", column: 0, beforeKey: "WIT-2" });
    expect((await keysIn("mira"))[0]).toEqual(["WIT-4", "WIT-2", "WIT-5"]);

    expect((await move("gast", { key: "WIT-2", column: 1 })).statusCode).toBe(
      403,
    );
    expect((await move("mira", { key: "WIT-2", column: 9 })).statusCode).toBe(
      400,
    );
    // The history records the transition like any other.
    const history = (
      await app.call("GET", "/issues/WIT-3/history", "mira")
    ).json();
    expect(history[0].items[0]).toMatchObject({
      field: "status",
      to: "In Progress",
    });
  });

  it("applies WIP limits and custom columns", async () => {
    const cols = [
      { name: "Offen", statusIds: [status.todo], wipLimit: null },
      { name: "Läuft", statusIds: [status.in_progress], wipLimit: 1 },
      { name: "Fertig", statusIds: [status.done], wipLimit: null },
    ];
    expect(
      (await app.call("PATCH", `/boards/${board}`, "mira", { columns: cols }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.call("PATCH", `/boards/${board}`, "lead", {
          columns: [{ name: "x", statusIds: ["nope"] }],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.call("PATCH", `/boards/${board}`, "lead", {
          columns: [
            { name: "a", statusIds: [status.todo] },
            { name: "b", statusIds: [status.todo] },
          ],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.call("PATCH", `/boards/${board}`, "lead", {
          columns: cols,
          name: "Werkstatt",
        })
      ).json(),
    ).toMatchObject({ name: "Werkstatt" });
    const view = await cards("mira");
    expect(
      view.columns.map((c: { name: string; overLimit: boolean }) => [
        c.name,
        c.overLimit,
      ]),
    ).toEqual([
      ["Offen", false],
      ["Läuft", true],
      ["Fertig", false],
    ]);

    // Dropping a status from all columns leaves its cards unmapped, not lost.
    await app.call("PATCH", `/boards/${board}`, "lead", {
      columns: [cols[0], cols[2]],
    });
    expect((await cards("mira")).unmapped).toBe(2);
    await app.call("PATCH", `/boards/${board}`, "lead", { columns: cols });
  });

  it("can point at another query and be deleted by an administrator", async () => {
    expect(
      (await app.call("DELETE", `/boards/${board}`, "mira")).statusCode,
    ).toBe(403);
    expect(
      (await app.call("DELETE", `/boards/${board}`, "lead")).statusCode,
    ).toBe(204);
    expect((await app.call("GET", `/boards/${board}`, "mira")).statusCode).toBe(
      404,
    );
  });
});
