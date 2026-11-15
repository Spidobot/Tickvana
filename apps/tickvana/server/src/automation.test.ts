import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "./db/schema.js";
import { startTestApp, type TestApp } from "./testing.js";

describeEachDb<TrackDb>("automations", (t) => {
  let app: TestApp;
  const ids: Record<string, string> = {};

  const drain = async () => {
    while ((await app.running.queue.runDue()) > 0);
  };
  const create = async (summary: string, as = "jonas", project = "WIT") =>
    (
      await app.call("POST", "/issues", as, {
        projectKey: project,
        type: ids.Task,
        fields: { summary },
      })
    ).json();
  const issue = async (key: string) =>
    (await app.call("GET", `/issues/${key}`, "root")).json();
  const rule = async (as: string, body: object) =>
    app.call("POST", "/automations", as, {
      projectKey: "WIT",
      conditions: [],
      ...body,
    });
  const runs = async (id: string) =>
    (await app.call("GET", `/automations/${id}/runs`, "root")).json();

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    for (const name of ["mira", "jonas", "fremd"]) await app.addUser(name);
    for (const key of ["WIT", "LAG"])
      await app.call("POST", "/projects", "root", { key, name: key });
    const roles = Object.fromEntries(
      (await app.db.selectFrom("track_project_role").selectAll().execute()).map(
        (r) => [r.name, r.id],
      ),
    );
    for (const [user, role] of [
      ["mira", "Administrators"],
      ["jonas", "Members"],
    ])
      await app.call("PUT", "/projects/WIT/members", "root", {
        roleId: roles[role!],
        principalType: "user",
        principalId: app.ids[user!],
      });
    await app.call("PUT", "/projects/LAG/members", "root", {
      roleId: roles.Members,
      principalType: "user",
      principalId: app.ids.jonas,
    });
    for (const row of await app.db
      .selectFrom("track_issue_type")
      .selectAll()
      .execute())
      ids[row.name] = row.id;
    for (const row of await app.db
      .selectFrom("track_status")
      .selectAll()
      .execute())
      ids[row.name] = row.id;
    await drain();
  }, 180_000);
  afterAll(() => app?.close());

  it("lets project administrators manage the project's rules", async () => {
    const body = {
      name: "Zuweisen",
      trigger: { kind: "event", types: ["issue.created"] },
      actions: [{ kind: "assign", to: "author" }],
    };
    expect((await rule("jonas", body)).statusCode).toBe(403);
    expect((await rule("fremd", body)).statusCode).toBe(404);
    expect(
      (
        await app.call("POST", "/automations", "mira", {
          ...body,
          projectKey: null,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await rule("mira", {
          ...body,
          actions: [{ kind: "rm -rf" }],
        })
      ).statusCode,
    ).toBe(400);
    const made = await rule("mira", body);
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({
      projectKey: "WIT",
      authorId: app.ids.mira,
      enabled: true,
    });
    expect(
      (await app.call("GET", "/automations?project=WIT", "mira")).json(),
    ).toHaveLength(1);
    await app.call("DELETE", `/automations/${made.json().id}`, "mira");
    expect(
      (await app.call("GET", "/automations?project=WIT", "mira")).json(),
    ).toEqual([]);
  });

  it("acts on events when the conditions hold, and logs each run", async () => {
    const made = (
      await rule("mira", {
        name: "Drucker an Mira",
        trigger: { kind: "event", types: ["issue.created"] },
        conditions: [
          { kind: "field", field: "summary", op: "contains", value: "drucker" },
        ],
        actions: [
          { kind: "assign", to: "author" },
          { kind: "comment", text: "{{key}} übernommen", visibility: "public" },
        ],
      })
    ).json();
    const hit = await create("Drucker streikt");
    const miss = await create("Monitor flackert");
    await drain();

    expect((await issue(hit.key)).fields.assignee).toBe(app.ids.mira);
    expect((await issue(miss.key)).fields.assignee).toBeNull();
    const comments = (
      await app.call("GET", `/issues/${hit.key}/comments`, "jonas")
    ).json();
    expect(comments).toHaveLength(1);
    expect(comments[0].authorId).toBe(app.ids.mira);
    expect(JSON.stringify(comments[0].body)).toContain(`${hit.key} übernommen`);

    const log = await runs(made.id);
    expect(log.map((r: { state: string }) => r.state).sort()).toEqual([
      "skipped",
      "success",
    ]);
    expect(
      log.find((r: { state: string }) => r.state === "success").log,
    ).toEqual([`Assigned to ${app.ids.mira}`, "Commented"]);
    await app.call("PUT", `/automations/${made.id}`, "mira", {
      ...made,
      enabled: false,
    });
  });

  it("does not let rules trigger each other in a loop", async () => {
    const ping = (
      await rule("mira", {
        name: "Ping",
        trigger: { kind: "event", types: ["issue.updated", "issue.commented"] },
        actions: [{ kind: "comment", text: "ping" }],
      })
    ).json();
    const pong = (
      await rule("mira", {
        name: "Pong",
        trigger: { kind: "event", types: ["issue.*"] },
        conditions: [{ kind: "field", field: "priority", op: "not_empty" }],
        actions: [{ kind: "setFields", fields: { labels: ["pong"] } }],
      })
    ).json();
    const made = await create("Schleife");
    await drain();
    await app.call("PATCH", `/issues/${made.key}`, "jonas", {
      fields: { summary: "Schleife?" },
    });
    await drain();
    // issue.created starts Pong; the edit starts Ping and Pong once each.
    expect(await runs(ping.id)).toHaveLength(1);
    expect(await runs(pong.id)).toHaveLength(2);
    const comments = (
      await app.call("GET", `/issues/${made.key}/comments`, "mira")
    ).json();
    expect(comments).toHaveLength(1);
    for (const id of [ping.id, pong.id])
      await app.call("DELETE", `/automations/${id}`, "mira");
  });

  it("acts only with the rights of the rule's author", async () => {
    const made = (
      await rule("mira", {
        name: "Lager-Ticket",
        trigger: { kind: "event", types: ["issue.created"] },
        actions: [
          {
            kind: "createIssue",
            projectKey: "LAG",
            typeId: ids.Task,
            fields: { summary: "Nachschub" },
          },
        ],
      })
    ).json();
    await create("Toner leer");
    await drain();
    const [run] = await runs(made.id);
    expect(run.state).toBe("failed");
    expect(
      await app.db
        .selectFrom("track_issue")
        .select("id")
        .where("summary", "=", "Nachschub")
        .execute(),
    ).toEqual([]);
    await app.call("DELETE", `/automations/${made.id}`, "mira");
  });

  it("offers manual rules on tickets to people who may edit them", async () => {
    const done = (
      await rule("mira", {
        name: "Erledigen",
        trigger: { kind: "manual" },
        actions: [{ kind: "transition", toStatusId: ids.Done }],
      })
    ).json();
    const made = await create("Per Knopf");
    expect(
      (
        await app.call("GET", `/issues/${made.key}/automations`, "jonas")
      ).json(),
    ).toEqual([{ id: done.id, name: "Erledigen" }]);
    expect(
      (
        await app.call(
          "POST",
          `/issues/${made.key}/automations/${done.id}`,
          "fremd",
        )
      ).statusCode,
    ).toBe(404);
    const result = (
      await app.call(
        "POST",
        `/issues/${made.key}/automations/${done.id}`,
        "jonas",
      )
    ).json();
    expect(result).toMatchObject({
      state: "success",
      log: ["Transition Done"],
    });
    expect((await issue(made.key)).fields.status).toBe(ids.Done);
    // Not on tickets of other projects.
    const lag = await create("Woanders", "jonas", "LAG");
    expect(
      (
        await app.call(
          "POST",
          `/issues/${lag.key}/automations/${done.id}`,
          "jonas",
        )
      ).statusCode,
    ).toBe(404);
  });

  it("runs scheduled rules for the tickets of a saved query", async () => {
    const query = (
      await app.call("POST", "/core/queries", "root", {
        name: "Alt",
        sql: "select id from issues where summary like 'Alt%'",
      })
    ).json();
    for (const s of ["Alt 1", "Alt 2"]) await create(s);
    await drain();
    const made = (
      await app.call("POST", "/automations", "root", {
        projectKey: null,
        name: "Alte markieren",
        trigger: { kind: "schedule", everyMinutes: 60, queryId: query.id },
        actions: [{ kind: "setFields", fields: { labels: ["alt"] } }],
      })
    ).json();
    // The scheduled job, as queue.start() would create it.
    const now = new Date();
    await app.db
      .insertInto("core_job")
      .values({
        id: "every:track-automation-schedule",
        type: "every:track-automation-schedule",
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
    // Through the scheduled job: the first round runs both tickets.
    await app.running.queue.runDue(new Date(Date.now() + 120_000));
    await drain();
    expect(await runs(made.id)).toHaveLength(2);
    // Within the interval, nothing runs again.
    await app.running.queue.runDue(new Date(Date.now() + 240_000));
    expect(await runs(made.id)).toHaveLength(2);
    const labelled = await app.db
      .selectFrom("track_issue")
      .select("summary")
      .where("summary", "like", "Alt%")
      .execute();
    for (const { summary } of labelled) {
      const key = (
        await app.db
          .selectFrom("track_issue")
          .select("key")
          .where("summary", "=", summary)
          .executeTakeFirstOrThrow()
      ).key;
      expect((await issue(key)).fields.labels).toEqual(["alt"]);
    }
  });
  it("tests a rule against a ticket without changing it", async () => {
    const made = (
      await rule("mira", {
        name: "Probe",
        trigger: { kind: "manual" },
        conditions: [
          { kind: "field", field: "summary", op: "contains", value: "probe" },
        ],
        actions: [{ kind: "setFields", fields: { labels: ["probe"] } }],
      })
    ).json();
    const hit = await create("Probe 1");
    const miss = await create("Anderes");
    const test = (key: string, as = "mira") =>
      app.call("POST", `/automations/${made.id}/test`, as, { issueKey: key });
    expect((await test(hit.key)).json()).toEqual({
      state: "success",
      log: ["Would run setFields"],
    });
    expect((await test(miss.key)).json()).toMatchObject({ state: "skipped" });
    expect((await test(hit.key, "jonas")).statusCode).toBe(403);
    expect((await issue(hit.key)).fields.labels).toEqual([]);
    expect(await runs(made.id)).toEqual([]);
  });
});
