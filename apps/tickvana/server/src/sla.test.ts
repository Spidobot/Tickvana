import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "./db/schema.js";
import { startTestApp, type TestApp } from "./testing.js";

const MIN = 60_000;

describeEachDb<TrackDb>("SLA engine", (t) => {
  let app: TestApp;
  const status: Record<string, string> = {};
  const priority: Record<string, string> = {};
  let task: string;

  /** Runs event subscribers and jobs due at `at`. */
  const drain = async (at = new Date()) => {
    while ((await app.running.queue.runDue(at)) > 0);
  };
  const cycle = async (key: string) =>
    (await app.call("GET", `/issues/${key}/sla`, "agent")).json()[0];
  const create = async (summary: string, fields: object = {}) => {
    const made = (
      await app.call("POST", "/issues", "kunde-agent", {
        projectKey: "SD",
        type: task,
        fields: { summary, ...fields },
      })
    ).json();
    await drain();
    return made.key as string;
  };
  const move = async (key: string, to: string) => {
    const tr = (await app.call("GET", `/issues/${key}/transitions`, "agent"))
      .json()
      .find((x: { toStatusId: string }) => x.toStatusId === status[to]);
    await app.call("POST", `/issues/${key}/transitions`, "agent", {
      transitionId: tr.id,
    });
    await drain();
  };

  beforeAll(async () => {
    app = await startTestApp(t.url, { queryRole: true });
    await app.addUser("root", { admin: true });
    for (const name of ["agent", "kunde-agent", "fremd"])
      await app.addUser(name);
    await app.call("POST", "/projects", "root", {
      key: "SD",
      name: "Support",
      kind: "service",
    });
    const project = (await app.call("GET", "/projects/SD", "root")).json();
    task = project.issueTypes[0].id;
    const roles = (await app.call("GET", "/admin/roles", "root")).json();
    for (const user of ["agent", "kunde-agent"])
      await app.call("PUT", "/projects/SD/members", "root", {
        roleId: roles.find((r: { name: string }) => r.name === "Members").id,
        principalType: "user",
        principalId: app.ids[user],
      });
    const meta = (await app.call("GET", "/meta", "root")).json();
    for (const s of meta.statuses) status[s.name] = s.id;
    for (const p of meta.priorities) priority[p.name] = p.id;
    // Round the clock in UTC, so working time equals wall time in this test.
    await app.db
      .insertInto("track_calendar")
      .values({
        id: "cal",
        name: "Immer",
        timezone: "UTC",
        hours_json: JSON.stringify(
          Object.fromEntries(
            ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [
              d,
              [["00:00", "24:00"]],
            ]),
          ),
        ),
        holidays_json: "[]",
      })
      .execute();
    await app.db
      .insertInto("track_sla_policy")
      .values({
        id: "pol",
        project_id: project.id,
        name: "Erste Antwort",
        calendar_id: "cal",
        start_json: JSON.stringify({ events: ["issue.created"] }),
        pause_json: JSON.stringify({ statusIds: [status["In Progress"]] }),
        stop_json: JSON.stringify({
          events: ["first_response"],
          statusCategories: ["done"],
        }),
        goals_json: JSON.stringify([
          { priorityIds: [priority.High], minutes: 60 },
          { minutes: 240 },
        ]),
      })
      .execute();
    // The breach check as queue.start() would schedule it.
    const now = new Date();
    await app.db
      .insertInto("core_job")
      .values({
        id: "every:track-sla-breaches",
        type: "every:track-sla-breaches",
        payload_json: "null",
        run_at: now,
        state: "pending",
        attempts: 0,
        locked_by: null,
        locked_at: null,
        last_error: null,
        created_at: now,
      })
      .execute();
  }, 180_000);
  afterAll(() => app?.close());

  it("starts a clock with the goal of the first matching rule", async () => {
    const key = await create("Drucker");
    const c = await cycle(key);
    expect(c).toMatchObject({
      policy: "Erste Antwort",
      paused: false,
      breached: false,
      stoppedAt: null,
    });
    expect(Date.parse(c.dueAt) - Date.parse(c.startedAt)).toBe(240 * MIN);

    // A higher priority shortens the goal, counted from the start.
    await app.call("PATCH", `/issues/${key}`, "agent", {
      fields: { priority: priority.High },
    });
    await drain();
    const after = await cycle(key);
    expect(Date.parse(after.dueAt) - Date.parse(after.startedAt)).toBe(
      60 * MIN,
    );
  });

  it("pauses while waiting and adds the paused time to the goal", async () => {
    const key = await create("Scanner");
    await move(key, "In Progress");
    expect((await cycle(key)).paused).toBe(true);
    // Back after a while: the due time moves by the paused time.
    const pausedAt = Date.now();
    await new Promise((r) => setTimeout(r, 1100));
    await move(key, "To Do");
    const c = await cycle(key);
    expect(c.paused).toBe(false);
    const shift = Date.parse(c.dueAt) - Date.parse(c.startedAt) - 240 * MIN;
    expect(shift).toBeGreaterThanOrEqual(1000);
    expect(shift).toBeLessThan(Date.now() - pausedAt + 1000);
  });

  it("stops at the first public answer by someone else", async () => {
    const key = await create("Monitor");
    const body = (text: string) => ({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });
    // The reporter's own comment and an internal note do not count.
    await app.call("POST", `/issues/${key}/comments`, "kunde-agent", {
      body: body("Noch da?"),
      visibility: "public",
    });
    await app.call("POST", `/issues/${key}/comments`, "agent", {
      body: body("intern"),
      visibility: "internal",
    });
    await drain();
    expect((await cycle(key)).stoppedAt).toBeNull();
    await app.call("POST", `/issues/${key}/comments`, "agent", {
      body: body("Wir sind dran"),
      visibility: "public",
    });
    await drain();
    expect(await cycle(key)).toMatchObject({
      breached: false,
      remainingMs: null,
    });
    expect((await cycle(key)).stoppedAt).not.toBeNull();
  });

  it("marks running clocks as breached and says so once", async () => {
    const key = await create("Router");
    // Travel: the goal ran out a minute ago. The breach job runs on the real clock.
    const issueId = (await app.call("GET", `/issues/${key}`, "agent")).json()
      .id;
    await app.db
      .updateTable("track_sla_cycle")
      .set({ due_at: new Date(Date.now() - MIN) })
      .where("issue_id", "=", issueId)
      .execute();
    await app.running.queue.runDue(new Date(Date.now() + 2 * MIN));
    await drain();
    expect((await cycle(key)).breached).toBe(true);
    const events = await app.db
      .selectFrom("core_event")
      .select("entity_id")
      .where("type", "=", "sla.breached")
      .execute();
    const issue = (await app.call("GET", `/issues/${key}`, "agent")).json();
    expect(events.filter((e) => e.entity_id === issue.id)).toHaveLength(1);
    await app.running.queue.runDue(new Date(Date.now() + 4 * MIN));
    await drain();
    expect(
      (
        await app.db
          .selectFrom("core_event")
          .select("id")
          .where("type", "=", "sla.breached")
          .execute()
      ).length,
    ).toBe(events.length);
  });

  it("shows clocks in SQL only for tickets the user may see", async () => {
    const run = (as: string) =>
      app.call("POST", "/core/query/run", as, {
        sql: "select issue_id, policy, breached from sla_cycles",
      });
    expect((await run("root")).json().rows.length).toBeGreaterThanOrEqual(4);
    await app.db
      .insertInto("core_global_grant")
      .values({
        id: "g",
        permission: "query.sql",
        grantee_type: "user",
        grantee_id: app.ids.fremd!,
        created_at: new Date(),
      })
      .execute();
    expect((await run("fremd")).json().rows).toEqual([]);
  });
});
