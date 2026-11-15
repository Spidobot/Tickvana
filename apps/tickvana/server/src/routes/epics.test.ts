import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<TrackDb>("epics", (t) => {
  let app: TestApp;
  const types: Record<string, string> = {};

  const create = async (summary: string, type: string, fields: object = {}) =>
    (
      await app.call("POST", "/issues", "mira", {
        projectKey: "WIT",
        type: types[type],
        fields: { summary, ...fields },
      })
    ).json();
  const epics = async (as = "mira") =>
    (await app.call("GET", "/projects/WIT/epics", as)).json();

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    for (const name of ["mira", "gast", "fremd"]) await app.addUser(name);
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
    for (const type of await app.db
      .selectFrom("track_issue_type")
      .selectAll()
      .execute())
      types[type.name] = type.id;
  }, 180_000);
  afterAll(() => app?.close());

  it("shows each epic with the progress of its tickets", async () => {
    const epic = await create("Druckerflotte", "Epic");
    const other = await create("Netz", "Epic");
    await create("Halle 1", "Story", { parent: epic.id, estimate: 3600 });
    const done = await create("Halle 2", "Task", {
      parent: epic.id,
      estimate: 7200,
    });
    await create("Lose", "Task");
    const finish = (
      await app.call("GET", `/issues/${done.key}/transitions`, "mira")
    )
      .json()
      .find((x: { name: string }) => x.name === "Done");
    await app.call("POST", `/issues/${done.key}/transitions`, "mira", {
      transitionId: finish.id,
    });

    expect(await epics()).toEqual([
      {
        id: epic.id,
        key: epic.key,
        summary: "Druckerflotte",
        statusId: expect.any(String),
        done: false,
        total: 2,
        doneCount: 1,
        estimateSec: 10_800,
        doneEstimateSec: 7200,
      },
      {
        id: other.id,
        key: other.key,
        summary: "Netz",
        statusId: expect.any(String),
        done: false,
        total: 0,
        doneCount: 0,
        estimateSec: 0,
        doneEstimateSec: 0,
      },
    ]);
  });

  it("keeps epics out of the backlog", async () => {
    const board = (
      await app.call("POST", "/projects/WIT/boards", "root", {
        name: "Team",
        kind: "scrum",
      })
    ).json().id;
    const backlog = (
      await app.call("GET", `/boards/${board}/backlog`, "mira")
    ).json().backlog;
    expect(backlog.map((i: { summary: string }) => i.summary)).toEqual([
      "Halle 1",
      "Lose",
    ]);
  });

  it("does not count tickets the viewer may not see", async () => {
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
    const epic = (await epics())[0];
    await create("Vertraulich", "Task", {
      parent: epic.id,
      securityLevel: "lvl",
      estimate: 999,
    });
    expect((await epics("mira"))[0]).toMatchObject({
      total: 3,
      estimateSec: 11_799,
    });
    expect((await epics("gast"))[0]).toMatchObject({
      total: 2,
      estimateSec: 10_800,
    });
    expect(
      (await app.call("GET", "/projects/WIT/epics", "fremd")).statusCode,
    ).toBe(404);
  });
});
