import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

const DAY = 86_400_000;
const dayOf = (offset: number) =>
  new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

describeEachDb<TrackDb>("board reports", (t) => {
  let app: TestApp;
  let board: string;
  let sprint: string;
  const status: Record<string, string> = {};

  const toStatus = async (key: string, category: string) => {
    const tr = (await app.call("GET", `/issues/${key}/transitions`, "mira"))
      .json()
      .find((x: { toStatusId: string }) => x.toStatusId === status[category]);
    expect(
      (
        await app.call("POST", `/issues/${key}/transitions`, "mira", {
          transitionId: tr.id,
        })
      ).statusCode,
    ).toBe(200);
  };
  const report = async (kind: string, as = "mira", query = "") =>
    (
      await app.call("GET", `/boards/${board}/reports/${kind}${query}`, as)
    ).json();
  /** Pretends a status change of a ticket happened at another time. */
  const backdate = async (key: string, at: Date) => {
    const issue = await app.db
      .selectFrom("track_issue")
      .select("id")
      .where("key", "=", key)
      .executeTakeFirstOrThrow();
    const last = await app.db
      .selectFrom("track_issue_change")
      .select("id")
      .where("issue_id", "=", issue.id)
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    await app.db
      .updateTable("track_issue_change")
      .set({ created_at: at })
      .where("id", "=", last.id)
      .execute();
  };

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    for (const name of ["mira", "fremd"]) await app.addUser(name);
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
      ["C", 1800],
    ] as const) {
      await app.call("POST", "/issues", "mira", {
        projectKey: "WIT",
        type: task,
        fields: { summary, estimate },
      });
    }
    // Everything was created four days ago.
    await app.db
      .updateTable("track_issue")
      .set({ created_at: daysAgo(4) })
      .execute();

    board = (
      await app.call("POST", "/projects/WIT/boards", "root", {
        name: "Team",
        kind: "scrum",
      })
    ).json().id;
    sprint = (
      await app.call("POST", `/boards/${board}/sprints`, "mira", {})
    ).json().id;
    for (const key of ["WIT-1", "WIT-2", "WIT-3"])
      await app.call("PUT", `/sprints/${sprint}/issues/${key}`, "mira");
    await app.call("POST", `/sprints/${sprint}/start`, "mira", {
      endAt: new Date(Date.now() + 2 * DAY).toISOString(),
    });
    // The sprint started two days ago with all three in it.
    const started = daysAgo(2);
    await app.db
      .updateTable("track_sprint")
      .set({ start_at: started })
      .where("id", "=", sprint)
      .execute();
    await app.db
      .updateTable("track_sprint_issue")
      .set({ added_at: started })
      .execute();

    // WIT-1: started three days ago, done yesterday. WIT-2: started yesterday.
    await toStatus("WIT-1", "in_progress");
    await backdate("WIT-1", daysAgo(3));
    await toStatus("WIT-1", "done");
    await backdate("WIT-1", daysAgo(1));
    await app.db
      .updateTable("track_issue")
      .set({ resolved_at: daysAgo(1) })
      .where("key", "=", "WIT-1")
      .execute();
    await toStatus("WIT-2", "in_progress");
    await backdate("WIT-2", daysAgo(1));
  }, 180_000);
  afterAll(() => app?.close());

  it("burns down the sprint day by day", async () => {
    const burn = await report("burndown");
    expect(burn.sprint.id).toBe(sprint);
    const byDay = Object.fromEntries(
      burn.points.map((p: { day: string; remainingSec: number | null }) => [
        p.day,
        p.remainingSec,
      ]),
    );
    expect(byDay[dayOf(-2)]).toBe(12_600);
    expect(byDay[dayOf(-1)]).toBe(9000);
    expect(byDay[dayOf(0)]).toBe(9000);
    expect(byDay[dayOf(1)]).toBeNull();
    // The ideal line goes from everything to nothing.
    expect(burn.points[0].idealSec).toBe(12_600);
    expect(burn.points.at(-1).idealSec).toBe(0);
  });

  it("shows the flow of tickets through the categories", async () => {
    const flow = await report("flow", "mira", "?days=7");
    expect(flow).toHaveLength(7);
    const at = (offset: number) =>
      flow.find((p: { day: string }) => p.day === dayOf(offset));
    expect(at(-4)).toMatchObject({ todo: 3, inProgress: 0, done: 0 });
    expect(at(-3)).toMatchObject({ todo: 2, inProgress: 1, done: 0 });
    expect(at(-1)).toMatchObject({ todo: 1, inProgress: 1, done: 1 });
    // Before the tickets existed: nothing.
    expect(at(-6)).toMatchObject({ todo: 0, inProgress: 0, done: 0 });
  });

  it("measures cycle time from starting work to done", async () => {
    const cycle = await report("cycle-time");
    expect(cycle.issues).toEqual([
      { key: "WIT-1", doneAt: expect.any(String), hours: 48 },
    ]);
    expect(cycle.averageHours).toBe(48);
    expect(cycle.medianHours).toBe(48);
  });

  it("counts velocity of closed sprints", async () => {
    expect(await report("velocity")).toEqual([]);
    await app.call("POST", `/sprints/${sprint}/complete`, "mira", {
      moveTo: null,
    });
    expect(await report("velocity")).toEqual([
      {
        sprintId: sprint,
        name: expect.any(String),
        committedSec: 12_600,
        completedSec: 3600,
      },
    ]);
  });

  it("shows nothing about tickets the viewer may not see", async () => {
    expect(await report("velocity", "fremd")).toEqual([
      {
        sprintId: sprint,
        name: expect.any(String),
        committedSec: 0,
        completedSec: 0,
      },
    ]);
    expect((await report("cycle-time", "fremd")).issues).toEqual([]);
    expect(
      (await report("flow", "fremd", "?days=7")).every(
        (p: { todo: number; inProgress: number; done: number }) =>
          p.todo + p.inProgress + p.done === 0,
      ),
    ).toBe(true);
    expect(
      (await app.call("GET", `/boards/${board}/reports/flow`, null)).statusCode,
    ).toBe(401);
  });
});
