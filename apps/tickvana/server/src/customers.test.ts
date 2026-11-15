import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "./db/schema.js";
import { startTestApp, type TestApp } from "./testing.js";

describeEachDb<TrackDb>("customer access", (t) => {
  let app: TestApp;
  let projectId: string;
  const keys: Record<string, string> = {};

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    await app.addUser("agent");
    for (const name of ["anna", "bert", "carl", "dora"])
      await app.addUser(name, { kind: "customer" });
    await app.call("POST", "/projects", "root", {
      key: "SD",
      name: "Support",
      kind: "service",
    });
    projectId = (
      await app.db
        .selectFrom("track_project")
        .select("id")
        .where("key", "=", "SD")
        .executeTakeFirstOrThrow()
    ).id;
    // anna and bert work for Müller GmbH, carl for another firm; dora is no customer here.
    await app.db
      .insertInto("track_organization")
      .values([
        { id: "o1", name: "Müller GmbH" },
        { id: "o2", name: "Schmidt AG" },
      ])
      .execute();
    await app.db
      .insertInto("track_organization_member")
      .values([
        { organization_id: "o1", user_id: app.ids.anna! },
        { organization_id: "o1", user_id: app.ids.bert! },
        { organization_id: "o2", user_id: app.ids.carl! },
      ])
      .execute();
    await app.db
      .insertInto("track_project_customer")
      .values([
        {
          project_id: projectId,
          principal_type: "organization",
          principal_id: "o1",
        },
        {
          project_id: projectId,
          principal_type: "user",
          principal_id: app.ids.carl!,
        },
      ])
      .execute();
    // The scheme lets customers browse and comment, and staff do everything.
    const [scheme] = (
      await app.call("GET", "/admin/permission-schemes", "root")
    ).json();
    for (const permission of [
      "project.browse",
      "issue.comment",
      "comment.internal",
      "issue.edit",
    ])
      await app.call(
        "POST",
        `/admin/permission-schemes/${scheme.id}/entries`,
        "root",
        { permission, granteeType: "customer" },
      );
    const roles = (await app.call("GET", "/admin/roles", "root")).json();
    await app.call("PUT", "/projects/SD/members", "root", {
      roleId: roles.find((r: { name: string }) => r.name === "Members").id,
      principalType: "user",
      principalId: app.ids.agent,
    });
    const task = (
      await app.db
        .selectFrom("track_issue_type")
        .select("id")
        .where("name", "=", "Task")
        .executeTakeFirstOrThrow()
    ).id;
    await app.call("POST", "/fields", "root", {
      key: "intern",
      name: "Intern",
      type: "text",
    });
    for (const who of ["anna", "carl"]) {
      const made = (
        await app.call("POST", "/issues", "agent", {
          projectKey: "SD",
          type: task,
          fields: {
            summary: `Anfrage von ${who}`,
            reporter: app.ids[who],
            intern: "geheim",
          },
        })
      ).json();
      keys[who] = made.key;
    }
  }, 180_000);
  afterAll(() => app?.close());

  const sees = async (who: string, key: string) =>
    (await app.call("GET", `/issues/${key}`, who)).statusCode === 200;

  it("shows customers their own tickets and those of their organization", async () => {
    const table: [string, string, boolean][] = [
      ["anna", "anna", true], // own
      ["bert", "anna", true], // same organization
      ["carl", "anna", false], // other organization
      ["dora", "anna", false], // not a customer of the project
      ["carl", "carl", true], // own, customer directly
      ["anna", "carl", false],
      ["agent", "anna", true], // staff see everything
    ];
    for (const [who, owner, expected] of table)
      expect(await sees(who, keys[owner]!), `${who} → ${owner}`).toBe(expected);
  });

  it("shows customers only portal fields", async () => {
    const asCustomer = (
      await app.call("GET", `/issues/${keys.anna}`, "anna")
    ).json();
    expect(asCustomer.fields.summary).toBe("Anfrage von anna");
    expect(asCustomer.fields).not.toHaveProperty("intern");
    expect(
      (await app.call("GET", `/issues/${keys.anna}`, "agent")).json().fields
        .intern,
    ).toBe("geheim");
  });

  it("keeps customers out of staff screens and internal comments", async () => {
    for (const path of [
      "/projects/SD",
      "/projects/SD/issues",
      `/issues/${keys.anna}/history`,
      `/issues/${keys.anna}/worklogs`,
      "/fields",
    ])
      expect((await app.call("GET", path, "anna")).statusCode, path).toBe(404);
    // The scheme grants editing to customers, but customers never get it.
    expect(
      (
        await app.call("PATCH", `/issues/${keys.anna}`, "anna", {
          fields: { summary: "x" },
        })
      ).statusCode,
    ).toBe(404);

    const body = (text: string) => ({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });
    expect(
      (
        await app.call("POST", `/issues/${keys.anna}/comments`, "anna", {
          body: body("Danke"),
          visibility: "internal",
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.call("POST", `/issues/${keys.anna}/comments`, "anna", {
          body: body("Danke"),
          visibility: "public",
        })
      ).statusCode,
    ).toBe(201);
    await app.call("POST", `/issues/${keys.anna}/comments`, "agent", {
      body: body("Nur fürs Team"),
      visibility: "internal",
    });
    const seen = (
      await app.call("GET", `/issues/${keys.anna}/comments`, "bert")
    ).json();
    expect(seen.map((c: { visibility: string }) => c.visibility)).toEqual([
      "public",
    ]);
    expect(
      (await app.call("GET", `/issues/${keys.anna}/comments`, "carl"))
        .statusCode,
    ).toBe(404);
  });

  it("gives customers nothing through the query engine", async () => {
    expect(
      (
        await app.call("POST", "/core/query/run", "anna", {
          sql: "select issue_key from issues",
        })
      ).statusCode,
    ).toBe(403);
  });
});
