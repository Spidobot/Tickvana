import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "./db/schema.js";
import { startTestApp, type TestApp } from "./testing.js";

describeEachDb<TrackDb>("system administration", (t) => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    await app.addUser("mira");
  }, 180_000);
  afterAll(() => app?.close());

  it("keeps the OIDC secret out of every answer", async () => {
    expect(
      (await app.call("GET", "/core/settings/oidc", "mira")).statusCode,
    ).toBe(403);
    expect(
      (
        await app.call("PUT", "/core/settings/oidc", "root", {
          enabled: true,
          issuer: "kein url",
        })
      ).statusCode,
    ).toBe(400);
    const saved = await app.call("PUT", "/core/settings/oidc", "root", {
      enabled: true,
      issuer: "https://login.example.org/tenant/v2.0",
      clientId: "tickvana",
      clientSecret: "geheim-123",
      trustEmail: true,
    });
    expect(saved.json()).toMatchObject({
      enabled: true,
      clientId: "tickvana",
      trustEmail: true,
      hasSecret: true,
    });
    expect(saved.body).not.toContain("geheim");
    // Leaving the secret out keeps it.
    const again = await app.call("PUT", "/core/settings/oidc", "root", {
      label: "Firmenkonto",
    });
    expect(again.json()).toMatchObject({
      label: "Firmenkonto",
      hasSecret: true,
    });
  });

  it("filters the audit log and pages through it", async () => {
    for (const key of ["AAA", "BBB", "CCC"])
      await app.call("POST", "/projects", "root", { key, name: key });
    await app.call("POST", "/core/groups", "root", { name: "Team" });
    const projects = (
      await app.call("GET", "/core/audit?type=project.*", "root")
    ).json();
    expect(projects.map((e: { type: string }) => e.type)).toEqual([
      "project.created",
      "project.created",
      "project.created",
    ]);
    expect(projects[0].actorId).toBe(app.ids.root);
    const first = (
      await app.call("GET", "/core/audit?type=project.created&limit=2", "root")
    ).json();
    const rest = (
      await app.call(
        "GET",
        `/core/audit?type=project.created&before=${first[1].id}`,
        "root",
      )
    ).json();
    expect([...first, ...rest].map((e: { id: string }) => e.id)).toEqual(
      projects.map((e: { id: string }) => e.id),
    );
    expect(
      (
        await app.call("GET", `/core/audit?actorId=${app.ids.mira}`, "root")
      ).json(),
    ).toEqual([]);
    expect((await app.call("GET", "/core/audit", "mira")).statusCode).toBe(403);
  });

  it("lists jobs and retries failed ones", async () => {
    const now = new Date();
    await app.db
      .insertInto("core_job")
      .values({
        id: "kaputt",
        type: "nobody.handles.this",
        payload_json: "null",
        run_at: now,
        state: "failed",
        attempts: 5,
        locked_by: null,
        locked_at: null,
        last_error: "boom",
        created_at: now,
      })
      .execute();
    const failed = (
      await app.call("GET", "/core/jobs?state=failed", "root")
    ).json();
    expect(failed.counts.failed).toBe(1);
    expect(failed.jobs).toEqual([
      expect.objectContaining({ id: "kaputt", lastError: "boom", attempts: 5 }),
    ]);
    expect(
      (await app.call("POST", "/core/jobs/kaputt/retry", "root")).statusCode,
    ).toBe(204);
    expect(
      (await app.call("POST", "/core/jobs/kaputt/retry", "root")).statusCode,
    ).toBe(404);
    const job = await app.db
      .selectFrom("core_job")
      .selectAll()
      .where("id", "=", "kaputt")
      .executeTakeFirstOrThrow();
    expect(job).toMatchObject({ state: "pending", attempts: 0 });
  });
});
