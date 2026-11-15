import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<TrackDb>("portal", (t) => {
  let app: TestApp;
  let requestType: string;
  let high: string;
  let low: string;

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    for (const name of ["anna", "bert"])
      await app.addUser(name, { kind: "customer" });
    await app.call("POST", "/projects", "root", {
      key: "SD",
      name: "Support",
      kind: "service",
    });
    const project = (await app.call("GET", "/projects/SD", "root")).json();
    const layout = (await app.call("GET", "/field-layouts", "root")).json()[0];
    const priorities = (await app.call("GET", "/meta", "root")).json()
      .priorities;
    high = priorities.find((p: { name: string }) => p.name === "High").id;
    low = priorities.find((p: { name: string }) => p.name === "Low").id;
    // The portal form asks for summary and description only.
    const fields = (await app.call("GET", "/fields", "root")).json();
    const id = (key: string) =>
      fields.find((f: { key: string }) => f.key === key).id;
    await app.call("PUT", `/field-layouts/${layout.id}/portal`, "root", [
      { fieldId: id("summary"), required: true },
      { fieldId: id("description") },
    ]);
    requestType = (
      await app.call("POST", "/projects/SD/request-types", "root", {
        name: "Drucker defekt",
        groupName: "Hardware",
        issueTypeId: project.issueTypes[0].id,
        fieldLayoutId: layout.id,
        defaults: { priority: high },
      })
    ).json().id;
    await app.db
      .insertInto("track_organization")
      .values({ id: "o1", name: "Müller GmbH" })
      .execute();
    await app.db
      .insertInto("track_organization_member")
      .values([
        { organization_id: "o1", user_id: app.ids.anna! },
        { organization_id: "o1", user_id: app.ids.bert! },
      ])
      .execute();
  }, 180_000);
  afterAll(() => app?.close());

  it("invites customers into a project", async () => {
    expect((await app.call("GET", "/portal/home", "anna")).json()).toEqual([]);
    const invited = await app.call(
      "POST",
      "/projects/SD/customers/invite",
      "root",
      { email: "anna@example.org", displayName: "Anna" },
    );
    expect(invited.json()).toEqual({ id: app.ids.anna, created: false });
    const fresh = await app.call(
      "POST",
      "/projects/SD/customers/invite",
      "root",
      {
        email: "neu@example.org",
        displayName: "Neu",
      },
    );
    expect(fresh.json().created).toBe(true);
    expect(
      (
        await app.call("POST", "/projects/SD/customers/invite", "anna", {
          email: "x@example.org",
          displayName: "X",
        })
      ).statusCode,
    ).toBe(404);
    const home = (await app.call("GET", "/portal/home", "anna")).json();
    expect(home).toEqual([
      {
        key: "SD",
        name: "Support",
        requestTypes: [
          expect.objectContaining({
            id: requestType,
            name: "Drucker defekt",
            groupName: "Hardware",
          }),
        ],
      },
    ]);
  });

  it("files requests with the form's fields and the type's fixed values", async () => {
    const form = (
      await app.call("GET", `/portal/request-types/${requestType}`, "anna")
    ).json();
    expect(form.fields.map((f: { key: string }) => f.key)).toEqual([
      "summary",
      "description",
    ]);
    const made = await app.call("POST", "/portal/requests", "anna", {
      requestTypeId: requestType,
      // priority is not on the form: the fixed value wins.
      fields: { summary: "Drucker im 2. OG", priority: low },
    });
    expect(made.statusCode).toBe(201);
    const issue = (
      await app.call("GET", `/issues/${made.json().key}`, "root")
    ).json();
    expect(issue.fields).toMatchObject({
      summary: "Drucker im 2. OG",
      priority: high,
      reporter: app.ids.anna,
    });
    expect(
      (
        await app.call("POST", "/portal/requests", "bert", {
          requestTypeId: requestType,
          fields: { summary: "x" },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("lists my requests and those of my organization", async () => {
    const mine = (await app.call("GET", "/portal/requests", "anna")).json();
    expect(mine).toEqual([
      expect.objectContaining({
        summary: "Drucker im 2. OG",
        requestType: "Drucker defekt",
      }),
    ]);
    // bert is in the same organization but no customer of SD yet.
    expect(
      (
        await app.call("GET", "/portal/requests?scope=organization", "bert")
      ).json(),
    ).toEqual([]);
    await app.db
      .insertInto("track_project_customer")
      .values({
        project_id: (await app.call("GET", "/projects/SD", "root")).json().id,
        principal_type: "organization",
        principal_id: "o1",
      })
      .execute();
    expect(
      (
        await app.call("GET", "/portal/requests?scope=organization", "bert")
      ).json(),
    ).toHaveLength(1);
    expect((await app.call("GET", "/portal/requests", "bert")).json()).toEqual(
      [],
    );
  });

  it("opens sign-up only when the administrator allows it", async () => {
    const body = {
      email: "selbst@example.org",
      displayName: "Selbst",
      password: "ein-langes-passwort",
    };
    expect((await app.call("GET", "/portal/settings", null)).json()).toEqual({
      signup: false,
    });
    expect(
      (await app.call("POST", "/portal/signup", null, body)).statusCode,
    ).toBe(403);
    await app.call("PUT", "/portal/settings", "root", {
      signup: true,
      openProjectIds: [],
    });
    const res = await app.call("POST", "/portal/signup", null, body);
    expect(res.statusCode).toBe(201);
    expect(String(res.headers["set-cookie"])).toMatch(/tvn_session=/);
    const user = await app.db
      .selectFrom("core_user")
      .select("kind")
      .where("email", "=", "selbst@example.org")
      .executeTakeFirstOrThrow();
    expect(user.kind).toBe("customer");
    expect(
      (await app.call("POST", "/portal/signup", null, body)).statusCode,
    ).toBe(409);
  });
});
