import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<TrackDb>("organizations and project customers", (t) => {
  let app: TestApp;
  let org: string;

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    await app.addUser("mira");
    await app.addUser("kim", { kind: "customer" });
    await app.call("POST", "/projects", "root", {
      key: "SD",
      name: "Support",
      kind: "service",
    });
    const project = (await app.call("GET", "/projects/SD", "root")).json();
    const layout = (await app.call("GET", "/field-layouts", "root")).json()[0];
    await app.call("POST", "/projects/SD/request-types", "root", {
      name: "Frage",
      issueTypeId: project.issueTypes[0].id,
      fieldLayoutId: layout.id,
    });
  }, 180_000);
  afterAll(() => app?.close());

  it("lets system administrators keep organizations and their members", async () => {
    expect(
      (
        await app.call("POST", "/admin/organizations", "mira", {
          name: "Müller GmbH",
        })
      ).statusCode,
    ).toBe(403);
    org = (
      await app.call("POST", "/admin/organizations", "root", {
        name: "Müller GmbH",
      })
    ).json().id;
    expect(
      (
        await app.call("POST", "/admin/organizations", "root", {
          name: "müller gmbh",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.call(
          "PUT",
          `/admin/organizations/${org}/members/${app.ids.kim}`,
          "root",
        )
      ).statusCode,
    ).toBe(204);
    expect((await app.call("GET", "/organizations", "mira")).json()).toEqual([
      {
        id: org,
        name: "Müller GmbH",
        members: [expect.objectContaining({ id: app.ids.kim })],
      },
    ]);
    // Customers do not see the list.
    expect((await app.call("GET", "/organizations", "kim")).statusCode).toBe(
      404,
    );
  });

  it("opens and closes the portal of a project for an organization", async () => {
    const portal = async () =>
      (await app.call("GET", "/portal/home", "kim")).json();
    expect(await portal()).toEqual([]);
    expect(
      (
        await app.call("PUT", "/projects/SD/customers", "mira", {
          principalType: "organization",
          principalId: org,
        })
      ).statusCode,
    ).toBe(404);
    await app.call("PUT", "/projects/SD/customers", "root", {
      principalType: "organization",
      principalId: org,
    });
    expect(
      (await app.call("GET", "/projects/SD/customers", "root")).json(),
    ).toEqual([
      { principalType: "organization", principalId: org, name: "Müller GmbH" },
    ]);
    expect((await portal()).map((p: { key: string }) => p.key)).toEqual(["SD"]);
    await app.call("DELETE", "/projects/SD/customers", "root", {
      principalType: "organization",
      principalId: org,
    });
    expect(await portal()).toEqual([]);
  });
});
