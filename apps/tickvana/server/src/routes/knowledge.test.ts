import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<TrackDb>("knowledge space of a project", (t) => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    await app.addUser("mira");
    await app.call("POST", "/projects", "root", {
      key: "HELP",
      name: "Hilfe",
      kind: "service",
    });
    const viewers = (
      await app.db
        .selectFrom("track_project_role")
        .select("id")
        .where("name", "=", "Viewers")
        .executeTakeFirstOrThrow()
    ).id;
    await app.call("PUT", "/projects/HELP/members", "root", {
      roleId: viewers,
      principalType: "user",
      principalId: app.ids.mira,
    });
  }, 180_000);
  afterAll(() => app?.close());

  it("lets project administrators choose the space, and shows it on the request form", async () => {
    expect(
      (
        await app.call("PUT", "/projects/HELP/knowledge-space", "mira", {
          spaceKey: "HILFE",
        })
      ).statusCode,
    ).toBe(403);
    await app.call("PUT", "/projects/HELP/knowledge-space", "root", {
      spaceKey: "HILFE",
    });
    expect(
      (await app.call("GET", "/projects/HELP/knowledge-space", "mira")).json(),
    ).toEqual({ spaceKey: "HILFE" });
    const project = (await app.call("GET", "/projects/HELP", "root")).json();
    const layout = (await app.call("GET", "/field-layouts", "root")).json()[0];
    const type = (
      await app.call("POST", "/projects/HELP/request-types", "root", {
        name: "Frage",
        issueTypeId: project.issueTypes[0].id,
        fieldLayoutId: layout.id,
      })
    ).json();
    expect(
      (await app.call("GET", `/portal/request-types/${type.id}`, "root")).json()
        .knowledgeSpace,
    ).toBe("HILFE");
    await app.call("PUT", "/projects/HELP/knowledge-space", "root", {
      spaceKey: null,
    });
    expect(
      (await app.call("GET", "/projects/HELP/knowledge-space", "root")).json(),
    ).toEqual({ spaceKey: null });
  });
});
