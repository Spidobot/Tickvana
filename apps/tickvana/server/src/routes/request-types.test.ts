import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<TrackDb>("request types", (t) => {
  let app: TestApp;
  let body: Record<string, unknown>;

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    await app.addUser("mira");
    await app.call("POST", "/projects", "root", {
      key: "SD",
      name: "Support",
      kind: "service",
    });
    const project = (await app.call("GET", "/projects/SD", "root")).json();
    const layout = (await app.call("GET", "/field-layouts", "root")).json()[0];
    const priority = (await app.call("GET", "/meta", "root")).json()
      .priorities[0].id;
    body = {
      name: "Passwort zurücksetzen",
      groupName: "Zugänge",
      issueTypeId: project.issueTypes[0].id,
      fieldLayoutId: layout.id,
      defaults: { priority },
    };
  }, 180_000);
  afterAll(() => app?.close());

  it("lets project administrators manage request types", async () => {
    expect(
      (await app.call("POST", "/projects/SD/request-types", "mira", body))
        .statusCode,
    ).toBe(404);
    for (const bad of [
      { issueTypeId: "nope" },
      { fieldLayoutId: "nope" },
      { defaults: { status: "x" } },
      { defaults: { gibtsnicht: 1 } },
    ])
      expect(
        (
          await app.call("POST", "/projects/SD/request-types", "root", {
            ...body,
            ...bad,
          })
        ).statusCode,
        JSON.stringify(bad),
      ).toBe(400);
    const made = await app.call(
      "POST",
      "/projects/SD/request-types",
      "root",
      body,
    );
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({
      ...body,
      position: 0,
      icon: "message-square",
    });
    const second = (
      await app.call("POST", "/projects/SD/request-types", "root", {
        ...body,
        name: "Neuer Laptop",
        groupName: "Hardware",
      })
    ).json();
    expect(second.position).toBe(1);

    await app.call("PUT", `/request-types/${second.id}`, "root", {
      ...body,
      name: "Neuer Laptop",
      position: 0,
    });
    await app.call("PUT", `/request-types/${made.json().id}`, "root", {
      ...body,
      position: 1,
    });
    const list = (
      await app.call("GET", "/projects/SD/request-types", "root")
    ).json();
    expect(list.map((x: { name: string }) => x.name)).toEqual([
      "Neuer Laptop",
      "Passwort zurücksetzen",
    ]);
    expect(
      (await app.call("DELETE", `/request-types/${second.id}`, "root"))
        .statusCode,
    ).toBe(204);
  });
});
