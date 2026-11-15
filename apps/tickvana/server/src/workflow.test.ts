import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "./db/schema.js";
import { startTestApp, type TestApp } from "./testing.js";
import { validateWorkflow } from "./workflow.js";

describeEachDb<TrackDb>("workflow engine", (t) => {
  let app: TestApp;
  const types: Record<string, string> = {};
  const roles: Record<string, string> = {};
  const status: Record<string, string> = {};
  let workflowId: string;
  let layoutId: string;
  let wontDo: string;
  let done: string;

  const create = async (as: string, fields: object, type = "Task") =>
    (
      await app.call("POST", "/issues", as, {
        projectKey: "WIT",
        type: types[type],
        fields,
      })
    ).json();
  const offered = async (as: string | null, key: string) =>
    (await app.call("GET", `/issues/${key}/transitions`, as))
      .json()
      .map((x: { name: string }) => x.name);
  const run = async (
    as: string,
    key: string,
    name: string,
    fields?: object,
  ) => {
    const list = (
      await app.call("GET", `/issues/${key}/transitions`, as)
    ).json() as { id: string; name: string }[];
    const id =
      list.find((x) => x.name === name)?.id ?? (await transitionId(name));
    return app.call("POST", `/issues/${key}/transitions`, as, {
      transitionId: id,
      fields,
    });
  };
  const transitionId = async (name: string) =>
    (
      await app.db
        .selectFrom("track_workflow_transition")
        .select("id")
        .where("name", "=", name)
        .executeTakeFirstOrThrow()
    ).id;
  const addTransition = (body: object) =>
    app.call("POST", `/workflows/${workflowId}/transitions`, "root", body);

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    for (const name of ["mira", "jonas", "gast"]) await app.addUser(name);
    await app.call("POST", "/projects", "root", {
      key: "WIT",
      name: "Werkstatt-IT",
    });
    for (const type of await app.db
      .selectFrom("track_issue_type")
      .selectAll()
      .execute())
      types[type.name] = type.id;
    for (const role of await app.db
      .selectFrom("track_project_role")
      .selectAll()
      .execute())
      roles[role.name] = role.id;
    for (const s of await app.db
      .selectFrom("track_status")
      .selectAll()
      .execute())
      status[s.category] = s.id;
    for (const [user, role] of [
      ["mira", "Members"],
      ["jonas", "Members"],
      ["gast", "Viewers"],
    ]) {
      await app.call("PUT", "/projects/WIT/members", "root", {
        roleId: roles[role!],
        principalType: "user",
        principalId: app.ids[user!],
      });
    }
    const d = JSON.parse(
      (
        await app.db
          .selectFrom("core_setting")
          .select("value_json")
          .where("key", "=", "track.defaults")
          .executeTakeFirstOrThrow()
      ).value_json,
    );
    workflowId = d.workflowId;
    layoutId = d.fieldLayoutId;
    const resolutions = await app.db
      .selectFrom("track_resolution")
      .selectAll()
      .execute();
    wontDo = resolutions.find((r) => r.name === "Won't Do")!.id;
    done = resolutions.find((r) => r.name === "Done")!.id;
  });
  afterAll(() => app?.close());

  it("offers the transitions that leave the current status, to people who may transition", async () => {
    const issue = await create("mira", { summary: "Drucker" });
    expect(await offered("mira", issue.key)).toEqual(["Done", "Start"]);
    expect(await offered("gast", issue.key)).toEqual([]);
    expect(await offered(null, issue.key).catch(() => "401")).toBeDefined();
    expect(
      (await app.call("GET", `/issues/${issue.key}/transitions`, null))
        .statusCode,
    ).toBe(401);
  });

  it("moves through the workflow, setting and clearing the resolution", async () => {
    const issue = await create("mira", { summary: "Scanner" });

    const started = await run("jonas", issue.key, "Start");
    expect(started.statusCode).toBe(200);
    expect(started.json().fields).toMatchObject({
      status: status.in_progress,
      resolution: null,
    });
    expect(started.json().resolvedAt).toBeNull();

    const finished = (await run("jonas", issue.key, "Done")).json();
    expect(finished.fields).toMatchObject({
      status: status.done,
      resolution: done,
    });
    expect(finished.resolvedAt).not.toBeNull();
    expect(await offered("mira", issue.key)).toEqual(["Start", "To Do"]);

    const reopened = (await run("mira", issue.key, "To Do")).json();
    expect(reopened.fields).toMatchObject({
      status: status.todo,
      resolution: null,
    });
    expect(reopened.resolvedAt).toBeNull();

    const history = (
      await app.call("GET", `/issues/${issue.key}/history`, "mira")
    ).json();
    expect(history.map((h: { items: object[] }) => h.items)).toEqual([
      [
        { field: "status", from: "Done", to: "To Do" },
        { field: "resolution", from: "Done", to: "" },
      ],
      [
        { field: "status", from: "In Progress", to: "Done" },
        { field: "resolution", from: "", to: "Done" },
      ],
      [{ field: "status", from: "To Do", to: "In Progress" }],
    ]);
    const events = await app.db
      .selectFrom("core_event")
      .select("payload_json")
      .where("type", "=", "issue.transitioned")
      .where("entity_id", "=", issue.id)
      .orderBy("id")
      .execute();
    expect(events.map((e) => JSON.parse(e.payload_json).transition)).toEqual([
      "Start",
      "Done",
      "To Do",
    ]);
  });

  it("refuses transitions that are not available or not allowed", async () => {
    const issue = await create("mira", { summary: "Monitor" });
    expect((await run("gast", issue.key, "Start")).statusCode).toBe(403);
    expect(
      (
        await app.call("POST", `/issues/${issue.key}/transitions`, "mira", {
          transitionId: await transitionId("To Do"),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.call("POST", `/issues/${issue.key}/transitions`, "mira", {
          transitionId: "nope",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await run("mira", issue.key, "Start", { status: status.done }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.call("GET", `/issues/${issue.key}`, "mira")).json().fields
        .status,
    ).toBe(status.todo);
  });

  it("lets only one of two simultaneous transitions win", async () => {
    const issue = await create("mira", { summary: "Doppelklick" });
    const [start, finish] = [
      await transitionId("Start"),
      await transitionId("Done"),
    ];
    const results = await Promise.all([
      app.call("POST", `/issues/${issue.key}/transitions`, "mira", {
        transitionId: start,
      }),
      app.call("POST", `/issues/${issue.key}/transitions`, "jonas", {
        transitionId: finish,
      }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(
      (await app.call("GET", `/issues/${issue.key}/history`, "mira")).json(),
    ).toHaveLength(1);
  });

  it("applies conditions, validators, a transition screen and post functions", async () => {
    // "Ablehnen": only the reporter or project administrators, needs a description, asks for labels, closes as Won't Do and unassigns.
    const rejectLayout = (
      await app.call("POST", "/field-layouts", "root", { name: "Ablehnen" })
    ).json();
    const labels = (await app.call("GET", "/fields", "root"))
      .json()
      .find((f: { key: string }) => f.key === "labels").id;
    await app.call(
      "PUT",
      `/field-layouts/${rejectLayout.id}/transition`,
      "root",
      [{ fieldId: labels, required: true }],
    );

    const made = await addTransition({
      name: "Ablehnen",
      fromStatusId: status.todo,
      toStatusId: status.done,
      fieldLayoutId: rejectLayout.id,
      rules: {
        conditions: [{ fn: "isReporter" }],
        validators: [
          { fn: "fieldRequired", field: "description" },
          { fn: "subtasksDone" },
        ],
        postFunctions: [
          { fn: "setResolution", resolutionId: wontDo },
          { fn: "clearAssignee" },
          { fn: "setField", field: "dueDate", value: null },
          { fn: "emit", type: "issue.rejected" },
        ],
      },
    });
    expect(made.statusCode).toBe(201);
    expect(
      (
        await addTransition({
          name: "Kaputt",
          fromStatusId: null,
          toStatusId: status.done,
          rules: { postFunctions: [{ fn: "runScript" }] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await addTransition({
          name: "Kaputt",
          fromStatusId: null,
          toStatusId: "nope",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.call("POST", `/workflows/${workflowId}/transitions`, "mira", {
          name: "x",
          fromStatusId: null,
          toStatusId: status.done,
        })
      ).statusCode,
    ).toBe(403);

    const issue = await create("mira", {
      summary: "Neuer Monitor",
      assignee: app.ids.mira,
      dueDate: "2026-12-01",
    });
    const sub = await create(
      "mira",
      { summary: "Angebot einholen", parent: issue.id },
      "Sub-task",
    );

    // Condition: jonas is not the reporter, so he is not even offered it.
    expect(await offered("jonas", issue.key)).toEqual(["Done", "Start"]);
    expect(await offered("mira", issue.key)).toEqual([
      "Ablehnen",
      "Done",
      "Start",
    ]);
    expect(
      (await run("jonas", issue.key, "Ablehnen", { labels: ["budget"] }))
        .statusCode,
    ).toBe(403);

    // Screen and validators.
    const noLabels = await run("mira", issue.key, "Ablehnen");
    expect(noLabels.statusCode).toBe(400);
    expect(noLabels.json().error.details).toEqual([
      { field: "labels", message: "Labels is required" },
    ]);
    const refused = await run("mira", issue.key, "Ablehnen", {
      labels: ["budget"],
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toBe(
      `description must be filled in. Still open underneath: ${sub.key}`,
    );
    expect(
      (await app.call("GET", `/issues/${issue.key}`, "mira")).json().fields,
    ).toMatchObject({ status: status.todo, labels: [] });

    await run("mira", sub.key, "Done");
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Kein Budget" }] },
      ],
    };
    const rejected = await run("mira", issue.key, "Ablehnen", {
      labels: ["budget"],
      description: doc,
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().fields).toMatchObject({
      status: status.done,
      resolution: wontDo,
      assignee: null,
      dueDate: null,
      labels: ["budget"],
      description: doc,
    });

    const history = (
      await app.call("GET", `/issues/${issue.key}/history`, "mira")
    ).json()[0].items;
    expect(
      Object.fromEntries(
        history.map((i: { field: string; to: string }) => [i.field, i.to]),
      ),
    ).toEqual({
      status: "Done",
      resolution: "Won't Do",
      labels: "budget",
      description: "Kein Budget",
      assignee: "",
      dueDate: "",
    });
    const events = await app.db
      .selectFrom("core_event")
      .select("type")
      .where("entity_id", "=", issue.id)
      .orderBy("id")
      .execute();
    expect(events.map((e) => e.type).slice(-2)).toEqual([
      "issue.transitioned",
      "issue.rejected",
    ]);
    void layoutId;
  });

  it("checks role and permission conditions", async () => {
    await addTransition({
      name: "Eskalieren",
      fromStatusId: status.todo,
      toStatusId: status.in_progress,
      rules: {
        conditions: [{ fn: "inRole", roleId: roles.Administrators }],
        postFunctions: [{ fn: "assignToActor" }],
      },
    });
    await addTransition({
      name: "Übernehmen",
      fromStatusId: status.todo,
      toStatusId: status.in_progress,
      rules: {
        conditions: [{ fn: "hasPermission", permission: "issue.assign" }],
        postFunctions: [{ fn: "assignToActor" }],
      },
    });
    const issue = await create("mira", { summary: "Server" });
    expect(await offered("mira", issue.key)).not.toContain("Eskalieren");
    expect(await offered("mira", issue.key)).toContain("Übernehmen");
    // root created the project and is its administrator.
    expect(await offered("root", issue.key)).toContain("Eskalieren");
    const taken = (await run("jonas", issue.key, "Übernehmen")).json();
    expect(taken.fields).toMatchObject({
      assignee: app.ids.jonas,
      status: status.in_progress,
    });
  });

  it("describes a workflow and finds unreachable statuses and dead ends", async () => {
    const described = (
      await app.call("GET", `/workflows/${workflowId}`, "gast")
    ).json();
    expect(
      described.statuses.map((s: { category: string }) => s.category),
    ).toEqual(["todo", "in_progress", "done"]);
    expect(
      described.transitions.find((x: { name: string }) => x.name === "Done")
        .rules.postFunctions[0].fn,
    ).toBe("setResolution");
    expect(described.problems).toEqual([]);
    expect((await app.call("GET", "/workflows/nope", "gast")).statusCode).toBe(
      404,
    );

    // A second workflow: Offen -> Prüfung, with "Wartet" that nothing leads to and nothing leaves.
    await app.db
      .insertInto("track_workflow")
      .values({ id: "w2", name: "Lücke" })
      .execute();
    await app.db
      .insertInto("track_status")
      .values([
        { id: "s_wait", name: "Wartet", category: "in_progress" },
        { id: "s_review", name: "Prüfung", category: "in_progress" },
      ])
      .execute();
    await app.db
      .insertInto("track_workflow_status")
      .values([
        { workflow_id: "w2", status_id: status.todo!, x: 0, y: 0 },
        { workflow_id: "w2", status_id: "s_review", x: 1, y: 0 },
        { workflow_id: "w2", status_id: "s_wait", x: 2, y: 0 },
        { workflow_id: "w2", status_id: status.done!, x: 3, y: 0 },
      ])
      .execute();
    await app.db
      .insertInto("track_workflow_transition")
      .values({
        id: "t1",
        workflow_id: "w2",
        from_status_id: status.todo!,
        to_status_id: "s_review",
        name: "Prüfen",
        field_layout_id: null,
        rules_json: "{}",
      })
      .execute();
    expect(await validateWorkflow(app.db, "w2")).toEqual([
      { statusId: "s_review", problem: "dead_end" },
      { statusId: "s_wait", problem: "unreachable" },
      { statusId: "s_wait", problem: "dead_end" },
      { statusId: status.done, problem: "unreachable" },
    ]);
    await app.db
      .insertInto("track_workflow_transition")
      .values([
        {
          id: "t2",
          workflow_id: "w2",
          from_status_id: "s_review",
          to_status_id: "s_wait",
          name: "Warten",
          field_layout_id: null,
          rules_json: "{}",
        },
        {
          id: "t3",
          workflow_id: "w2",
          from_status_id: null,
          to_status_id: status.done!,
          name: "Fertig",
          field_layout_id: null,
          rules_json: "{}",
        },
      ])
      .execute();
    expect(await validateWorkflow(app.db, "w2")).toEqual([]);
  });
});
