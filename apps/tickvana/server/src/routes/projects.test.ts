import { grantGlobal } from "@tvn/core";
import { describeEachDb } from "@tvn/core/testing";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { CoreDb } from "@tvn/core";
import type { TrackDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<TrackDb>("projects", (t) => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    for (const name of ["maker", "helper", "outsider"]) await app.addUser(name);
    await grantGlobal(
      app.db as unknown as Kysely<CoreDb>,
      "project.create",
      "user",
      app.ids.maker!,
    );
  });
  afterAll(() => app?.close());

  it("creates a project from a template, for those allowed to", async () => {
    const body = { key: "wit", name: "Werkstatt-IT" };
    expect(
      (await app.call("POST", "/projects", "outsider", body)).statusCode,
    ).toBe(403);
    expect((await app.call("POST", "/projects", null, body)).statusCode).toBe(
      401,
    );

    const made = await app.call("POST", "/projects", "maker", body);
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({
      key: "WIT",
      name: "Werkstatt-IT",
      kind: "software",
      leadId: app.ids.maker,
      archived: false,
    });

    const detail = (await app.call("GET", "/projects/wit", "maker")).json();
    expect(detail.issueTypes.map((i: { name: string }) => i.name)).toEqual([
      "Epic",
      "Bug",
      "Story",
      "Task",
      "Sub-task",
    ]);
    expect(
      new Set(
        detail.issueTypes.map((i: { workflowId: string }) => i.workflowId),
      ).size,
    ).toBe(1);

    const business = await app.call("POST", "/projects", "root", {
      key: "HR",
      name: "Personal",
      kind: "business",
      leadId: app.ids.helper,
    });
    expect(business.statusCode).toBe(201);
    const hr = (await app.call("GET", "/projects/HR", "helper")).json();
    expect(hr.issueTypes.map((i: { name: string }) => i.name)).toEqual([
      "Task",
      "Sub-task",
    ]);

    const events = await app.db
      .selectFrom("core_event")
      .select("type")
      .where("type", "=", "project.created")
      .execute();
    expect(events).toHaveLength(2);
  });

  it("validates keys and keeps them unique", async () => {
    for (const key of ["W", "1AB", "TOOLONGKEY1", "A-B", ""]) {
      expect(
        (await app.call("POST", "/projects", "maker", { key, name: "x" }))
          .statusCode,
        key,
      ).toBe(400);
    }
    expect(
      (
        await app.call("POST", "/projects", "maker", {
          key: "WIT",
          name: "Doppelt",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.call("POST", "/projects", "maker", {
          key: "NEU",
          name: "x",
          leadId: "nobody",
        })
      ).statusCode,
    ).toBe(400);
  });

  it("shows projects only to people who may browse them", async () => {
    const keys = async (as: string | null) =>
      (await app.call("GET", "/projects", as))
        .json()
        .map((p: { key: string }) => p.key);
    expect(await keys("root")).toEqual(["HR", "WIT"]);
    expect(await keys("maker")).toEqual(["WIT"]);
    expect(await keys("helper")).toEqual(["HR"]);
    expect(await keys("outsider")).toEqual([]);
    expect(await keys(null)).toEqual([]);

    // Unknown and invisible projects look the same.
    expect(
      (await app.call("GET", "/projects/WIT", "outsider")).statusCode,
    ).toBe(404);
    expect(
      (await app.call("GET", "/projects/NOPE", "outsider")).statusCode,
    ).toBe(404);
    expect((await app.call("GET", "/projects/WIT", null)).statusCode).toBe(401);
  });

  it("lets administrators manage members, who then get access", async () => {
    const members = (
      await app.call("GET", "/projects/WIT/members", "maker")
    ).json();
    const role = (name: string) =>
      members.roles.find((r: { name: string }) => r.name === name).id;
    expect(members.members).toEqual([
      {
        roleId: role("Administrators"),
        principalType: "user",
        principalId: app.ids.maker,
      },
    ]);

    const viewer = {
      roleId: role("Viewers"),
      principalType: "user",
      principalId: app.ids.helper,
    };
    expect(
      (await app.call("PUT", "/projects/WIT/members", "helper", viewer))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.call("PUT", "/projects/WIT/members", "maker", viewer))
        .statusCode,
    ).toBe(204);
    expect(
      (await app.call("PUT", "/projects/WIT/members", "maker", viewer))
        .statusCode,
    ).toBe(204);
    expect(
      (
        await app.call("PUT", "/projects/WIT/members", "maker", {
          ...viewer,
          principalId: "nobody",
        })
      ).statusCode,
    ).toBe(400);

    expect((await app.call("GET", "/projects/WIT", "helper")).statusCode).toBe(
      200,
    );
    // A viewer sees the project but may not change it.
    expect(
      (await app.call("PATCH", "/projects/WIT", "helper", { name: "Gekapert" }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.call("GET", "/projects/WIT/members", "helper")).statusCode,
    ).toBe(403);

    expect(
      (await app.call("DELETE", "/projects/WIT/members", "maker", viewer))
        .statusCode,
    ).toBe(204);
    expect((await app.call("GET", "/projects/WIT", "helper")).statusCode).toBe(
      404,
    );
  });

  it("updates, archives and restores", async () => {
    const renamed = await app.call("PATCH", "/projects/WIT", "maker", {
      name: "Werkstatt IT",
      leadId: app.ids.helper,
    });
    expect(renamed.json()).toMatchObject({
      name: "Werkstatt IT",
      leadId: app.ids.helper,
      archived: false,
    });
    expect(
      (await app.call("PATCH", "/projects/WIT", "maker", { leadId: "nobody" }))
        .statusCode,
    ).toBe(400);

    expect(
      (
        await app.call("PATCH", "/projects/WIT", "maker", { archived: true })
      ).json().archived,
    ).toBe(true);
    const listed = async (query = "") =>
      (await app.call("GET", `/projects${query}`, "maker"))
        .json()
        .map((p: { key: string }) => p.key);
    expect(await listed()).toEqual([]);
    expect(await listed("?includeArchived=true")).toEqual(["WIT"]);
    // Still administrable, so it can come back.
    expect(
      (
        await app.call("PATCH", "/projects/WIT", "maker", { archived: false })
      ).json().archived,
    ).toBe(false);
    expect(await listed()).toEqual(["WIT"]);

    const types = await app.db
      .selectFrom("core_event")
      .select("type")
      .where("type", "like", "project.%")
      .orderBy("id")
      .execute();
    expect(types.map((e) => e.type).slice(-3)).toEqual([
      "project.updated",
      "project.archived",
      "project.restored",
    ]);
  });

  it("maps issue types to workflow and layout, guarding tickets in use", async () => {
    const detail = (await app.call("GET", "/projects/HR", "root")).json();
    const all = await app.db
      .selectFrom("track_issue_type")
      .selectAll()
      .execute();
    const bug = all.find((i) => i.name === "Bug")!;
    const task = all.find((i) => i.name === "Task")!;

    const added = await app.call(
      "PUT",
      `/projects/HR/issue-types/${bug.id}`,
      "root",
      {},
    );
    expect(added.json().map((i: { name: string }) => i.name)).toEqual([
      "Bug",
      "Task",
      "Sub-task",
    ]);
    expect(
      (await app.call("PUT", `/projects/HR/issue-types/nope`, "root", {}))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.call("PUT", `/projects/HR/issue-types/${bug.id}`, "root", {
          workflowId: "nope",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.call(
          "PUT",
          `/projects/HR/issue-types/${bug.id}`,
          "outsider",
          {},
        )
      ).statusCode,
    ).toBe(404);

    // A ticket of type Task in a status that an empty workflow does not have.
    const now = new Date();
    const status = await app.db
      .selectFrom("track_status")
      .select("id")
      .where("category", "=", "todo")
      .executeTakeFirstOrThrow();
    const priority = await app.db
      .selectFrom("track_priority")
      .select("id")
      .where("name", "=", "Medium")
      .executeTakeFirstOrThrow();
    await app.db
      .insertInto("track_issue")
      .values({
        id: "i1",
        project_id: detail.id,
        number: 1,
        key: "HR-1",
        type_id: task.id,
        status_id: status.id,
        summary: "x",
        description_json: null,
        description_text: "",
        priority_id: priority.id,
        resolution_id: null,
        reporter_id: app.ids.root!,
        assignee_id: null,
        parent_id: null,
        security_level_id: null,
        rank: "m",
        due_date: null,
        estimate_sec: null,
        remaining_sec: null,
        spent_sec: 0,
        created_at: now,
        updated_at: now,
        resolved_at: null,
      })
      .execute();
    await app.db
      .insertInto("track_workflow")
      .values({ id: "empty", name: "Leer" })
      .execute();

    expect(
      (
        await app.call("PUT", `/projects/HR/issue-types/${task.id}`, "root", {
          workflowId: "empty",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.call("PUT", `/projects/HR/issue-types/${bug.id}`, "root", {
          workflowId: "empty",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.call("DELETE", `/projects/HR/issue-types/${task.id}`, "root"))
        .statusCode,
    ).toBe(409);
    expect(
      (await app.call("DELETE", `/projects/HR/issue-types/${bug.id}`, "root"))
        .statusCode,
    ).toBe(204);
    expect(
      (await app.call("GET", "/projects/HR", "root"))
        .json()
        .issueTypes.map((i: { name: string }) => i.name),
    ).toEqual(["Task", "Sub-task"]);
  });
});
