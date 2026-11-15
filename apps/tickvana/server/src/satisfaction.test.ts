import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "./db/schema.js";
import { startTestApp, type TestApp } from "./testing.js";

describeEachDb<TrackDb>("satisfaction", (t) => {
  let app: TestApp;
  let key: string;
  const drain = async () => {
    while ((await app.running.queue.runDue()) > 0);
  };

  beforeAll(async () => {
    app = await startTestApp(t.url, { queryRole: true });
    await app.addUser("root", { admin: true });
    await app.addUser("agent");
    for (const name of ["kim", "ole"])
      await app.addUser(name, { kind: "customer" });
    await app.call("POST", "/projects", "root", {
      key: "SD",
      name: "Support",
      kind: "service",
    });
    const project = (await app.call("GET", "/projects/SD", "root")).json();
    const roles = (await app.call("GET", "/admin/roles", "root")).json();
    await app.call("PUT", "/projects/SD/members", "root", {
      roleId: roles.find((r: { name: string }) => r.name === "Members").id,
      principalType: "user",
      principalId: app.ids.agent,
    });
    for (const who of ["kim", "ole"])
      await app.call("PUT", "/projects/SD/customers", "root", {
        principalType: "user",
        principalId: app.ids[who],
      });
    const layout = (await app.call("GET", "/field-layouts", "root")).json()[0];
    const rt = (
      await app.call("POST", "/projects/SD/request-types", "root", {
        name: "Frage",
        issueTypeId: project.issueTypes[0].id,
        fieldLayoutId: layout.id,
      })
    ).json();
    key = (
      await app.call("POST", "/portal/requests", "kim", {
        requestTypeId: rt.id,
        fields: { summary: "Drucker" },
      })
    ).json().key;
  }, 180_000);
  afterAll(() => app?.close());

  it("asks the reporter once the request is done and takes one rating", async () => {
    expect(
      (await app.call("GET", `/portal/requests/${key}/rating`, "kim")).json(),
    ).toEqual({ canRate: false, score: null });
    expect(
      (
        await app.call("POST", `/portal/requests/${key}/rating`, "kim", {
          score: 5,
        })
      ).statusCode,
    ).toBe(409);
    const done = (await app.call("GET", `/issues/${key}/transitions`, "agent"))
      .json()
      .find((x: { name: string }) => x.name === "Done");
    await app.call("POST", `/issues/${key}/transitions`, "agent", {
      transitionId: done.id,
    });
    await drain();
    const mails = await app.db
      .selectFrom("core_job")
      .select("payload_json")
      .where("type", "=", "mail.send")
      .execute();
    expect(
      mails.some((m) => JSON.parse(m.payload_json).subject.includes(key)),
    ).toBe(true);

    expect(
      (await app.call("GET", `/portal/requests/${key}/rating`, "kim")).json(),
    ).toEqual({ canRate: true, score: null });
    expect(
      (
        await app.call("POST", `/portal/requests/${key}/rating`, "ole", {
          score: 1,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.call("POST", `/portal/requests/${key}/rating`, "kim", {
          score: 6,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.call("POST", `/portal/requests/${key}/rating`, "kim", {
          score: 4,
          comment: "Schnell, danke",
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.call("POST", `/portal/requests/${key}/rating`, "kim", {
          score: 1,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await app.call("GET", `/issues/${key}/comments`, "agent")).json(),
    ).toHaveLength(1);
  });

  it("reports ratings per project and in SQL", async () => {
    expect(
      (await app.call("GET", "/projects/SD/satisfaction", "agent")).json(),
    ).toEqual({
      count: 1,
      average: 4,
      distribution: [0, 0, 0, 1, 0],
    });
    const res = await app.call("POST", "/core/query/run", "root", {
      sql: "select issue_key, cf_satisfaction from issues where cf_satisfaction is not null",
    });
    expect(res.json().rows).toEqual([{ issue_key: key, cf_satisfaction: 4 }]);
  });
});
