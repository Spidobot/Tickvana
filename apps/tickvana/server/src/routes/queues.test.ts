import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<TrackDb>("queues and canned responses", (t) => {
  let app: TestApp;
  let queryId: string;

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    for (const name of ["agent", "gast"]) await app.addUser(name);
    await app.call("POST", "/projects", "root", {
      key: "SD",
      name: "Support",
      kind: "service",
    });
    const roles = (await app.call("GET", "/admin/roles", "root")).json();
    const role = (name: string) =>
      roles.find((r: { name: string }) => r.name === name).id;
    for (const [user, r] of [
      ["agent", "Members"],
      ["gast", "Viewers"],
    ])
      await app.call("PUT", "/projects/SD/members", "root", {
        roleId: role(r!),
        principalType: "user",
        principalId: app.ids[user!],
      });
    const task = (await app.call("GET", "/projects/SD", "root")).json()
      .issueTypes[0].id;
    for (const summary of ["Drucker 1", "Drucker 2", "Monitor"])
      await app.call("POST", "/issues", "root", {
        projectKey: "SD",
        type: task,
        fields: { summary },
      });
    queryId = (
      await app.call("POST", "/core/queries", "root", {
        name: "Drucker",
        sql: "select issue_key from issues where summary like 'Drucker%' order by issue_key desc",
        visibility: "global",
      })
    ).json().id;
  }, 180_000);
  afterAll(() => app?.close());

  it("counts and lists the tickets of a queue for agents", async () => {
    expect(
      (
        await app.call("POST", "/projects/SD/queues", "agent", {
          name: "Drucker",
          queryId,
        })
      ).statusCode,
    ).toBe(403);
    const made = (
      await app.call("POST", "/projects/SD/queues", "root", {
        name: "Drucker",
        queryId,
      })
    ).json();
    expect(
      (await app.call("GET", "/projects/SD/queues", "agent")).json(),
    ).toEqual([
      expect.objectContaining({ id: made.id, name: "Drucker", count: 2 }),
    ]);
    const issues = (
      await app.call("GET", `/queues/${made.id}/issues`, "agent")
    ).json();
    // In the query's order.
    expect(issues.map((i: { summary: string }) => i.summary)).toEqual([
      "Drucker 2",
      "Drucker 1",
    ]);
    expect(
      (await app.call("GET", "/projects/SD/queues", "gast")).statusCode,
    ).toBe(403);
    expect(
      (await app.call("DELETE", `/queues/${made.id}`, "root")).statusCode,
    ).toBe(204);
  });

  it("keeps canned responses per project", async () => {
    const body = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Danke, wir kümmern uns." }],
        },
      ],
    };
    expect(
      (
        await app.call("POST", "/projects/SD/canned-responses", "agent", {
          name: "Danke",
          body,
        })
      ).statusCode,
    ).toBe(403);
    const made = (
      await app.call("POST", "/projects/SD/canned-responses", "root", {
        name: "Danke",
        body,
      })
    ).json();
    const list = (
      await app.call("GET", "/projects/SD/canned-responses", "agent")
    ).json();
    expect(list).toEqual([
      { id: made.id, projectKey: "SD", name: "Danke", body },
    ]);
    expect(
      (await app.call("DELETE", `/canned-responses/${made.id}`, "root"))
        .statusCode,
    ).toBe(204);
  });
});
