import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<TrackDb>("roles, schemes and security levels", (t) => {
  let app: TestApp;
  let roles: Record<string, string>;

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    for (const name of ["mira", "jonas"]) await app.addUser(name);
    await app.call("POST", "/projects", "root", { key: "WIT", name: "WIT" });
    roles = Object.fromEntries(
      (await app.call("GET", "/admin/roles", "root"))
        .json()
        .map((r: { name: string; id: string }) => [r.name, r.id]),
    );
    await app.call("PUT", "/projects/WIT/members", "root", {
      roleId: roles.Administrators,
      principalType: "user",
      principalId: app.ids.mira,
    });
  }, 180_000);
  afterAll(() => app?.close());

  it("manages roles and refuses to delete used ones", async () => {
    expect(
      (await app.call("POST", "/admin/roles", "mira", { name: "Prüfer" }))
        .statusCode,
    ).toBe(403);
    const made = (
      await app.call("POST", "/admin/roles", "root", { name: "Prüfer" })
    ).json();
    expect(
      (
        await app.call("PATCH", `/admin/roles/${made.id}`, "root", {
          name: "Prüfung",
        })
      ).json(),
    ).toEqual({ id: made.id, name: "Prüfung" });
    roles.Prüfung = made.id;
    expect(
      (await app.call("DELETE", `/admin/roles/${roles.Members}`, "root"))
        .statusCode,
    ).toBe(409);
  });

  it("changes what a project allows through its scheme", async () => {
    const schemes = (
      await app.call("GET", "/admin/permission-schemes", "root")
    ).json();
    expect(schemes[0].projects).toEqual(["WIT"]);
    const copy = (
      await app.call("POST", "/admin/permission-schemes", "root", {
        name: "Streng",
        copyFrom: schemes[0].id,
      })
    ).json();
    expect(copy.entries).toHaveLength(schemes[0].entries.length);
    // Jonas gets the new role; only the new scheme lets that role browse.
    await app.call("PUT", "/projects/WIT/members", "root", {
      roleId: roles.Prüfung,
      principalType: "user",
      principalId: app.ids.jonas,
    });
    expect((await app.call("GET", "/projects/WIT", "jonas")).statusCode).toBe(
      404,
    );
    expect(
      (
        await app.call(
          "POST",
          `/admin/permission-schemes/${copy.id}/entries`,
          "root",
          {
            permission: "project.browse",
            granteeType: "role",
          },
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.call(
          "POST",
          `/admin/permission-schemes/${copy.id}/entries`,
          "root",
          {
            permission: "project.browse",
            granteeType: "role",
            granteeId: roles.Prüfung,
          },
        )
      ).statusCode,
    ).toBe(201);
    // Project administrators cannot switch schemes, system administrators can.
    expect(
      (
        await app.call("PATCH", "/projects/WIT", "mira", {
          permissionSchemeId: copy.id,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.call("PATCH", "/projects/WIT", "root", {
          permissionSchemeId: copy.id,
        })
      ).json().permissionSchemeId,
    ).toBe(copy.id);
    expect((await app.call("GET", "/projects/WIT", "jonas")).statusCode).toBe(
      200,
    );
    expect(
      (await app.call("DELETE", `/admin/permission-schemes/${copy.id}`, "root"))
        .statusCode,
    ).toBe(409);
  });

  it("keeps notification rules per scheme", async () => {
    const [scheme] = (
      await app.call("GET", "/admin/notification-schemes", "root")
    ).json();
    const made = await app.call(
      "POST",
      `/admin/notification-schemes/${scheme.id}/entries`,
      "root",
      { eventType: "issue.deleted", recipientType: "project_lead" },
    );
    expect(made.json()).toMatchObject({
      eventType: "issue.deleted",
      recipientType: "project_lead",
      recipientId: null,
    });
    expect(
      (
        await app.call(
          "DELETE",
          `/admin/notification-schemes/${scheme.id}/entries/${made.json().id}`,
          "root",
        )
      ).statusCode,
    ).toBe(204);
  });

  it("lets project administrators manage security levels", async () => {
    expect(
      (
        await app.call("POST", "/projects/WIT/security-levels", "jonas", {
          name: "Intern",
        })
      ).statusCode,
    ).toBe(403);
    const level = (
      await app.call("POST", "/projects/WIT/security-levels", "mira", {
        name: "Intern",
      })
    ).json();
    const m = await app.call(
      "POST",
      `/security-levels/${level.id}/members`,
      "mira",
      { granteeType: "user", granteeId: app.ids.mira },
    );
    expect(m.statusCode).toBe(201);
    expect(
      (await app.call("GET", "/projects/WIT/security-levels", "mira")).json(),
    ).toEqual([
      {
        id: level.id,
        name: "Intern",
        members: [
          { id: m.json().id, granteeType: "user", granteeId: app.ids.mira },
        ],
      },
    ]);
    expect(
      (
        await app.call(
          "DELETE",
          `/security-levels/${level.id}/members/${m.json().id}`,
          "jonas",
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.call("DELETE", `/security-levels/${level.id}`, "mira"))
        .statusCode,
    ).toBe(204);
  });
});
