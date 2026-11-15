import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "./db/schema.js";
import { startTestApp, type TestApp } from "./testing.js";

describeEachDb<TrackDb>("issues", (t) => {
  let app: TestApp;
  const types: Record<string, string> = {};
  const roles: Record<string, string> = {};
  let high: string;

  const create = (
    as: string,
    fields: object,
    type = "Task",
    projectKey = "WIT",
  ) =>
    app.call("POST", "/issues", as, { projectKey, type: types[type], fields });
  const addMember = (project: string, role: string, user: string) =>
    app.call("PUT", `/projects/${project}/members`, "root", {
      roleId: roles[role],
      principalType: "user",
      principalId: app.ids[user],
    });

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    for (const name of ["mira", "jonas", "gast", "fremd"])
      await app.addUser(name);
    for (const body of [
      { key: "WIT", name: "Werkstatt-IT" },
      { key: "LAG", name: "Lager" },
      { key: "HR", name: "Personal", kind: "business" },
    ]) {
      expect(
        (await app.call("POST", "/projects", "root", body)).statusCode,
      ).toBe(201);
    }
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
    for (const project of ["WIT", "LAG", "HR"]) {
      await addMember(project, "Members", "mira");
      await addMember(project, "Members", "jonas");
    }
    await addMember("WIT", "Viewers", "gast");
    high = (
      await app.db
        .selectFrom("track_priority")
        .select("id")
        .where("name", "=", "High")
        .executeTakeFirstOrThrow()
    ).id;
  });
  afterAll(() => app?.close());

  it("creates a ticket with defaults and the next key", async () => {
    const made = await create("mira", {
      summary: "  Etikettendrucker druckt versetzt  ",
      labels: ["hardware", "halle-2", "hardware"],
      dueDate: "2026-11-27",
      estimate: 7200,
    });
    expect(made.statusCode).toBe(201);
    const issue = made.json();
    expect(issue).toMatchObject({
      key: "WIT-1",
      number: 1,
      spentSec: 0,
      resolvedAt: null,
    });
    expect(issue.fields).toMatchObject({
      summary: "Etikettendrucker druckt versetzt",
      type: types.Task,
      reporter: app.ids.mira,
      assignee: null,
      resolution: null,
      labels: ["halle-2", "hardware"],
      dueDate: "2026-11-27",
      estimate: 7200,
      remaining: 7200,
      description: null,
    });
    const status = await app.db
      .selectFrom("track_status")
      .select("category")
      .where("id", "=", issue.fields.status)
      .executeTakeFirstOrThrow();
    expect(status.category).toBe("todo");
    const priority = await app.db
      .selectFrom("track_priority")
      .select("name")
      .where("id", "=", issue.fields.priority)
      .executeTakeFirstOrThrow();
    expect(priority.name).toBe("Medium");

    expect((await app.call("GET", "/issues/wit-1", "gast")).json().key).toBe(
      "WIT-1",
    );
    const events = await app.db
      .selectFrom("core_event")
      .select(["type", "actor_id"])
      .where("entity_id", "=", issue.id)
      .execute();
    expect(events).toEqual([{ type: "issue.created", actor_id: app.ids.mira }]);
  });

  it("hands out 50 consecutive numbers to 50 parallel creates", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        create(
          i % 2 ? "mira" : "jonas",
          { summary: `Parallel ${i}` },
          "Task",
          "LAG",
        ),
      ),
    );
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    const numbers = results.map((r) => r.json().number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(new Set(results.map((r) => r.json().key)).size).toBe(50);
    const project = await app.db
      .selectFrom("track_project")
      .select("issue_counter")
      .where("key", "=", "LAG")
      .executeTakeFirstOrThrow();
    expect(project.issue_counter).toBe(50);
  }, 120_000);

  it("leaves no gap when a create fails", async () => {
    const before = (
      await app.db
        .selectFrom("track_project")
        .select("issue_counter")
        .where("key", "=", "WIT")
        .executeTakeFirstOrThrow()
    ).issue_counter;
    expect((await create("mira", { summary: "" })).statusCode).toBe(400);
    expect(
      (await create("mira", { summary: "x", priority: "nope" })).statusCode,
    ).toBe(400);
    expect(
      (await create("mira", { summary: "x", dueDate: "2026-02-30" }))
        .statusCode,
    ).toBe(400);
    expect(
      (await create("mira", { summary: "x", labels: ["zwei worte"] }))
        .statusCode,
    ).toBe(400);
    expect(
      (await create("mira", { summary: "x" }, "Task", "NOPE")).statusCode,
    ).toBe(404);
    expect(
      (
        await app.call("POST", "/issues", "mira", {
          projectKey: "HR",
          type: types.Bug,
          fields: { summary: "x" },
        })
      ).statusCode,
    ).toBe(400);
    expect((await create("mira", { summary: "Danach" })).json().number).toBe(
      before + 1,
    );
  });

  it("enforces permissions per project and per action", async () => {
    expect((await create("gast", { summary: "x" })).statusCode).toBe(403);
    expect((await create("fremd", { summary: "x" })).statusCode).toBe(404);
    expect(
      (
        await app.call("POST", "/issues", null, {
          projectKey: "WIT",
          type: types.Task,
          fields: { summary: "x" },
        })
      ).statusCode,
    ).toBe(401);
    expect((await app.call("GET", "/issues/WIT-1", "fremd")).statusCode).toBe(
      404,
    );
    expect((await app.call("GET", "/issues/WIT-999", "mira")).statusCode).toBe(
      404,
    );
    expect(
      (
        await app.call("PATCH", "/issues/WIT-1", "gast", {
          fields: { summary: "Gekapert" },
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.call("DELETE", "/issues/WIT-1", "mira")).statusCode).toBe(
      403,
    );
    expect(
      (await app.call("GET", "/projects/WIT/issues", "fremd")).statusCode,
    ).toBe(404);
    expect(
      (await app.call("GET", "/projects/WIT/issues", "gast")).json().length,
    ).toBeGreaterThan(0);
  });

  it("edits fields and records who changed what", async () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Seit dem Rollenwechsel" }],
        },
      ],
    };
    const first = await app.call("PATCH", "/issues/WIT-1", "jonas", {
      fields: {
        summary: "Drucker Halle 2 druckt versetzt",
        priority: high,
        assignee: app.ids.mira,
        description: doc,
        labels: ["hardware"],
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().fields).toMatchObject({
      summary: "Drucker Halle 2 druckt versetzt",
      priority: high,
      assignee: app.ids.mira,
      description: doc,
      labels: ["hardware"],
      dueDate: "2026-11-27",
    });
    expect(new Date(first.json().updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.json().createdAt).getTime(),
    );

    // Sending the same values again changes nothing and records nothing.
    await app.call("PATCH", "/issues/WIT-1", "jonas", {
      fields: { priority: high, labels: ["hardware"] },
    });
    await app.call("PATCH", "/issues/WIT-1", "mira", {
      fields: { assignee: null },
    });

    const history = (
      await app.call("GET", "/issues/WIT-1/history", "gast")
    ).json();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      actorId: app.ids.mira,
      items: [{ field: "assignee", from: "mira", to: "" }],
    });
    const byField = Object.fromEntries(
      history[1].items.map((i: { field: string; from: string; to: string }) => [
        i.field,
        [i.from, i.to],
      ]),
    );
    expect(byField).toEqual({
      summary: [
        "Etikettendrucker druckt versetzt",
        "Drucker Halle 2 druckt versetzt",
      ],
      priority: ["Medium", "High"],
      assignee: ["", "mira"],
      description: ["", "Seit dem Rollenwechsel"],
      labels: ["halle-2, hardware", "hardware"],
    });

    const issue = (await app.call("GET", "/issues/WIT-1", "mira")).json();
    const events = await app.db
      .selectFrom("core_event")
      .select("type")
      .where("entity_id", "=", issue.id)
      .orderBy("id")
      .execute();
    expect(events.map((e) => e.type)).toEqual([
      "issue.created",
      "issue.updated",
      "issue.assigned",
    ]);

    for (const [field, value] of [
      ["status", "x"],
      ["type", types.Bug],
      ["resolution", "x"],
    ] as const) {
      expect(
        (
          await app.call("PATCH", "/issues/WIT-1", "mira", {
            fields: { [field]: value },
          })
        ).statusCode,
        field,
      ).toBe(400);
    }
    expect(
      (
        await app.call("PATCH", "/issues/WIT-1", "mira", {
          fields: { summary: " " },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.call("PATCH", "/issues/WIT-1", "mira", {
          fields: { assignee: "nobody" },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("stores custom fields with the ticket and requires what the layout requires", async () => {
    const field = (
      await app.call("POST", "/fields", "root", {
        key: "standort",
        name: "Standort",
        type: "select",
      })
    ).json();
    const withOption = (
      await app.call("POST", `/fields/${field.id}/options`, "root", {
        value: "Halle 2",
      })
    ).json();
    const option = withOption.options[0].id;
    await app.call("POST", "/fields", "root", {
      key: "geraet",
      name: "Gerät",
      type: "text",
      config: { default: "unbekannt" },
    });

    const made = (
      await create("mira", { summary: "Scanner", standort: option })
    ).json();
    expect(made.fields).toMatchObject({
      standort: option,
      geraet: "unbekannt",
    });
    expect(
      (await create("mira", { summary: "x", standort: "nope" })).statusCode,
    ).toBe(400);

    const edited = (
      await app.call("PATCH", `/issues/${made.key}`, "mira", {
        fields: { standort: null, geraet: "MC3300" },
      })
    ).json();
    expect(edited.fields).toMatchObject({ standort: null, geraet: "MC3300" });
    const history = (
      await app.call("GET", `/issues/${made.key}/history`, "mira")
    ).json();
    expect(history[0].items).toEqual(
      expect.arrayContaining([
        { field: "standort", from: "Halle 2", to: "" },
        { field: "geraet", from: "unbekannt", to: "MC3300" },
      ]),
    );

    // Make the field required on the default layout: create and edit now insist on it.
    const d = JSON.parse(
      (
        await app.db
          .selectFrom("core_setting")
          .select("value_json")
          .where("key", "=", "track.defaults")
          .executeTakeFirstOrThrow()
      ).value_json,
    );
    const layout = (
      await app.call("GET", `/field-layouts/${d.fieldLayoutId}`, "root")
    ).json();
    for (const op of ["create", "edit"]) {
      const res = await app.call(
        "PUT",
        `/field-layouts/${d.fieldLayoutId}/${op}`,
        "root",
        [...layout.items[op], { fieldId: field.id, required: true }],
      );
      expect(res.statusCode).toBe(200);
    }
    const missing = await create("mira", { summary: "Ohne Standort" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.details).toEqual([
      { field: "standort", message: "Standort is required" },
    ]);
    expect(
      (
        await app.call("PATCH", `/issues/${made.key}`, "mira", {
          fields: { summary: "Scanner 2" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.call("PATCH", `/issues/${made.key}`, "mira", {
          fields: { standort: option },
        })
      ).statusCode,
    ).toBe(200);
    for (const op of ["create", "edit"])
      await app.call(
        "PUT",
        `/field-layouts/${d.fieldLayoutId}/${op}`,
        "root",
        layout.items[op],
      );
  });

  it("keeps the hierarchy sound", async () => {
    const epic = (
      await create("mira", { summary: "Druckerflotte erneuern" }, "Epic")
    ).json();
    const story = (
      await create(
        "mira",
        { summary: "Halle 2 umstellen", parent: epic.id },
        "Story",
      )
    ).json();
    const sub = (
      await create(
        "mira",
        { summary: "Treiber testen", parent: story.id },
        "Sub-task",
      )
    ).json();
    expect(story.fields.parent).toBe(epic.id);

    expect(
      (await create("mira", { summary: "x", parent: sub.id }, "Task"))
        .statusCode,
    ).toBe(400);
    expect(
      (await create("mira", { summary: "x", parent: epic.id }, "Epic"))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.call("PATCH", `/issues/${story.key}`, "mira", {
          fields: { parent: story.id },
        })
      ).statusCode,
    ).toBe(400);
    const other = (
      await create("mira", { summary: "Fremd" }, "Task", "LAG")
    ).json();
    expect(
      (
        await app.call("PATCH", `/issues/${sub.key}`, "mira", {
          fields: { parent: other.id },
        })
      ).statusCode,
    ).toBe(400);

    // A story that has a sub-task cannot become a sub-task itself.
    expect(
      (
        await app.call("POST", `/issues/${story.key}/type`, "mira", {
          type: types["Sub-task"],
        })
      ).statusCode,
    ).toBe(409);
    const asBug = await app.call("POST", `/issues/${story.key}/type`, "mira", {
      type: types.Bug,
    });
    expect(asBug.json().fields.type).toBe(types.Bug);
    expect(
      (await app.call("GET", `/issues/${story.key}/history`, "mira")).json()[0]
        .items,
    ).toEqual([{ field: "type", from: "Story", to: "Bug" }]);

    expect(
      (await app.call("DELETE", `/issues/${story.key}`, "root")).statusCode,
    ).toBe(409);
    expect(
      (
        await app.call("POST", `/issues/${story.key}/move`, "mira", {
          projectKey: "LAG",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await app.call("DELETE", `/issues/${sub.key}`, "root")).statusCode,
    ).toBe(204);
    expect(
      (await app.call("DELETE", `/issues/${story.key}`, "root")).statusCode,
    ).toBe(204);
    expect(
      (await app.call("GET", `/issues/${story.key}`, "mira")).statusCode,
    ).toBe(404);
    const deleted = await app.db
      .selectFrom("core_event")
      .select("payload_json")
      .where("type", "=", "issue.deleted")
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(deleted.payload_json)).toMatchObject({ key: story.key });
  });

  it("moves a ticket to another project with a new key", async () => {
    const component = "c1";
    const witId = (
      await app.db
        .selectFrom("track_project")
        .select("id")
        .where("key", "=", "WIT")
        .executeTakeFirstOrThrow()
    ).id;
    await app.db
      .insertInto("track_component")
      .values({
        id: component,
        project_id: witId,
        name: "Drucker",
        lead_id: null,
      })
      .execute();
    const made = (
      await create("mira", {
        summary: "Wandert",
        components: [component],
        labels: ["umzug"],
      })
    ).json();
    expect(made.fields.components).toEqual([component]);
    expect(
      (
        await create(
          "mira",
          { summary: "x", components: [component] },
          "Task",
          "LAG",
        )
      ).statusCode,
    ).toBe(400);

    const counter = async () =>
      (
        await app.db
          .selectFrom("track_project")
          .select("issue_counter")
          .where("key", "=", "LAG")
          .executeTakeFirstOrThrow()
      ).issue_counter;
    const before = await counter();
    expect(
      (
        await app.call("POST", `/issues/${made.key}/move`, "gast", {
          projectKey: "LAG",
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.call("POST", `/issues/${made.key}/move`, "mira", {
          projectKey: "WIT",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.call("POST", `/issues/${made.key}/move`, "mira", {
          projectKey: "HR",
          type: types.Bug,
        })
      ).statusCode,
    ).toBe(400);

    const moved = await app.call("POST", `/issues/${made.key}/move`, "mira", {
      projectKey: "LAG",
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({
      id: made.id,
      key: `LAG-${before + 1}`,
    });
    expect(moved.json().fields).toMatchObject({
      summary: "Wandert",
      components: [],
      labels: ["umzug"],
      status: made.fields.status,
    });
    expect(await counter()).toBe(before + 1);
    // The old key leads to the moved ticket (links written before keep working).
    expect(
      (await app.call("GET", `/issues/${made.key}`, "mira")).json().key,
    ).toBe(moved.json().key);
    expect(
      (
        await app.call("GET", `/issues/${moved.json().key}/history`, "mira")
      ).json()[0].items,
    ).toEqual([{ field: "key", from: made.key, to: moved.json().key }]);
  });

  it("hides tickets behind a security level, also in lists", async () => {
    const witId = (
      await app.db
        .selectFrom("track_project")
        .select("id")
        .where("key", "=", "WIT")
        .executeTakeFirstOrThrow()
    ).id;
    await app.db
      .insertInto("track_security_level")
      .values({ id: "lvl", project_id: witId, name: "Personal" })
      .execute();
    await app.db
      .insertInto("track_security_level_member")
      .values({
        id: "lvlm",
        level_id: "lvl",
        grantee_type: "reporter",
        grantee_id: null,
      })
      .execute();
    const secret = (
      await create("mira", { summary: "Abmahnung", securityLevel: "lvl" })
    ).json();

    expect(
      (await app.call("GET", `/issues/${secret.key}`, "mira")).statusCode,
    ).toBe(200);
    expect(
      (await app.call("GET", `/issues/${secret.key}`, "jonas")).statusCode,
    ).toBe(404);
    expect(
      (await app.call("GET", `/issues/${secret.key}`, "root")).statusCode,
    ).toBe(200);
    const keys = async (as: string) =>
      (await app.call("GET", "/projects/WIT/issues?limit=200", as))
        .json()
        .map((i: { key: string }) => i.key);
    expect(await keys("mira")).toContain(secret.key);
    expect(await keys("jonas")).not.toContain(secret.key);
    expect(
      (await create("mira", { summary: "x", securityLevel: "nope" }))
        .statusCode,
    ).toBe(400);
  });
});
