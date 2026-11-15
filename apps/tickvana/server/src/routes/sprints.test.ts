import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<TrackDb>("sprints and backlog", (t) => {
  let app: TestApp;
  let board: string;
  let first: string;
  let second: string;
  const status: Record<string, string> = {};
  const inTwoWeeks = () => new Date(Date.now() + 14 * 86_400_000).toISOString();

  const backlog = async (as = "mira") =>
    (await app.call("GET", `/boards/${board}/backlog`, as)).json();
  const keysOf = (list: { key: string }[]) => list.map((i) => i.key);
  const done = async (key: string) => {
    const tr = (await app.call("GET", `/issues/${key}/transitions`, "mira"))
      .json()
      .find((x: { toStatusId: string }) => x.toStatusId === status.done);
    await app.call("POST", `/issues/${key}/transitions`, "mira", {
      transitionId: tr.id,
    });
  };

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
    for (const [summary, estimate] of [
      ["A", 3600],
      ["B", 7200],
      ["C", null],
      ["D", 1800],
    ] as const) {
      await app.call("POST", "/issues", "mira", {
        projectKey: "WIT",
        type: task,
        fields: { summary, estimate },
      });
    }
    board = (
      await app.call("POST", "/projects/WIT/boards", "root", {
        name: "Sprintboard",
        kind: "scrum",
      })
    ).json().id;
  }, 180_000);
  afterAll(() => app?.close());

  it("plans sprints from the backlog", async () => {
    expect(keysOf((await backlog()).backlog)).toEqual([
      "WIT-1",
      "WIT-2",
      "WIT-3",
      "WIT-4",
    ]);
    expect(
      (await app.call("POST", `/boards/${board}/sprints`, "gast", {}))
        .statusCode,
    ).toBe(403);
    first = (
      await app.call("POST", `/boards/${board}/sprints`, "mira", {
        goal: "Drucker stabil",
      })
    ).json().id;
    second = (
      await app.call("POST", `/boards/${board}/sprints`, "mira", {
        name: "Danach",
      })
    ).json().id;

    for (const key of ["WIT-1", "WIT-2"])
      expect(
        (await app.call("PUT", `/sprints/${first}/issues/${key}`, "mira"))
          .statusCode,
      ).toBe(204);
    await app.call("PUT", `/sprints/${second}/issues/WIT-3`, "mira");
    // Moving a ticket into another sprint takes it out of the first.
    await app.call("PUT", `/sprints/${second}/issues/WIT-2`, "mira");
    await app.call("PUT", `/sprints/${first}/issues/WIT-2`, "mira");
    expect(
      (await app.call("PUT", `/sprints/${first}/issues/WIT-3`, "gast"))
        .statusCode,
    ).toBe(403);

    const view = await backlog("gast");
    expect(
      view.sprints.map(
        (s: {
          name: string;
          goal: string;
          issues: { key: string }[];
          estimateSec: number;
        }) => [s.name, s.goal, keysOf(s.issues), s.estimateSec],
      ),
    ).toEqual([
      ["Sprintboard 1", "Drucker stabil", ["WIT-1", "WIT-2"], 10_800],
      ["Danach", "", ["WIT-3"], 0],
    ]);
    expect(keysOf(view.backlog)).toEqual(["WIT-4"]);
  });

  it("starts one sprint at a time and shows only it on the board", async () => {
    expect(
      await (await app.call("GET", `/boards/${board}/cards`, "mira")).json()
        .columns[0].cards,
    ).toEqual([]);
    expect(
      (
        await app.call("POST", `/sprints/${first}/start`, "mira", {
          endAt: new Date(Date.now() - 1000).toISOString(),
        })
      ).statusCode,
    ).toBe(400);
    const started = await app.call("POST", `/sprints/${first}/start`, "mira", {
      endAt: inTwoWeeks(),
    });
    expect(started.json()).toMatchObject({ state: "active" });
    expect(
      (
        await app.call("POST", `/sprints/${second}/start`, "mira", {
          endAt: inTwoWeeks(),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.call("POST", `/sprints/${first}/start`, "mira", {
          endAt: inTwoWeeks(),
        })
      ).statusCode,
    ).toBe(409);

    const cards = (
      await app.call("GET", `/boards/${board}/cards`, "mira")
    ).json();
    expect(cards.columns[0].cards.map((c: { key: string }) => c.key)).toEqual([
      "WIT-1",
      "WIT-2",
    ]);
  });

  it("completes a sprint, carrying unfinished tickets into the next", async () => {
    await done("WIT-1");
    expect(
      (
        await app.call("POST", `/sprints/${first}/complete`, "mira", {
          moveTo: "nope",
        })
      ).statusCode,
    ).toBe(400);
    const res = await app.call("POST", `/sprints/${first}/complete`, "mira", {
      moveTo: second,
    });
    expect(res.json()).toMatchObject({
      done: 1,
      carried: 1,
      sprint: { state: "closed" },
    });

    const view = await backlog();
    expect(
      view.sprints.map((s: { name: string; issues: { key: string }[] }) => [
        s.name,
        keysOf(s.issues),
      ]),
    ).toEqual([["Danach", ["WIT-2", "WIT-3"]]]);
    // The closed sprint remembers both: one done, one carried over.
    const history = await app.db
      .selectFrom("track_sprint_issue")
      .select(["issue_id", "removed_at"])
      .where("sprint_id", "=", first)
      .execute();
    expect(history).toHaveLength(2);
    expect(history.filter((h) => h.removed_at !== null)).toHaveLength(1);
    expect(
      (await app.call("PUT", `/sprints/${first}/issues/WIT-4`, "mira"))
        .statusCode,
    ).toBe(409);
  });

  it("sends tickets back to the backlog when a planned sprint is deleted", async () => {
    expect(
      (await app.call("DELETE", `/sprints/${first}`, "mira")).statusCode,
    ).toBe(409);
    expect(
      (await app.call("DELETE", `/sprints/${second}`, "mira")).statusCode,
    ).toBe(204);
    expect(keysOf((await backlog()).backlog)).toEqual([
      "WIT-2",
      "WIT-3",
      "WIT-4",
    ]);
  });

  it("has no sprints on a kanban board", async () => {
    const kanban = (
      await app.call("POST", "/projects/WIT/boards", "root", { name: "Fluss" })
    ).json().id;
    expect(
      (await app.call("POST", `/boards/${kanban}/sprints`, "mira", {}))
        .statusCode,
    ).toBe(409);
  });
});
