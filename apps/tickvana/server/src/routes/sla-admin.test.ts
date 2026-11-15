import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";

describeEachDb<TrackDb>("SLA policies and calendars", (t) => {
  let app: TestApp;
  const week = { mon: [["09:00", "17:00"]], fri: [["09:00", "15:00"]] };

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    await app.addUser("mira");
    await app.call("POST", "/projects", "root", {
      key: "SD",
      name: "Support",
      kind: "service",
    });
  }, 180_000);
  afterAll(() => app?.close());

  it("lets system administrators keep calendars", async () => {
    const body = {
      name: "Büro",
      timezone: "Europe/Berlin",
      hours: week,
      holidays: ["2026-12-24"],
    };
    expect(
      (await app.call("POST", "/admin/calendars", "mira", body)).statusCode,
    ).toBe(403);
    for (const bad of [
      { timezone: "Mars/Olympus" },
      { hours: { mon: [["9", "17"]] } },
      { holidays: ["24.12."] },
    ])
      expect(
        (
          await app.call("POST", "/admin/calendars", "root", {
            ...body,
            ...bad,
          })
        ).statusCode,
        JSON.stringify(bad),
      ).toBe(400);
    const made = await app.call("POST", "/admin/calendars", "root", body);
    expect(made.statusCode).toBe(201);
    expect((await app.call("GET", "/calendars", "mira")).json()).toEqual([
      { id: made.json().id, ...body },
    ]);
  });

  it("lets project administrators keep policies that name a calendar", async () => {
    const [cal] = (await app.call("GET", "/calendars", "root")).json();
    const body = {
      name: "Lösung",
      calendarId: cal.id,
      start: { events: ["issue.created"] },
      pause: { statusIds: [] },
      stop: { events: [], statusIds: [], statusCategories: ["done"] },
      goals: [{ priorityIds: [], requestTypeIds: [], minutes: 480 }],
    };
    expect(
      (await app.call("POST", "/projects/SD/sla-policies", "mira", body))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.call("POST", "/projects/SD/sla-policies", "root", {
          ...body,
          calendarId: "x",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.call("POST", "/projects/SD/sla-policies", "root", {
          ...body,
          goals: [],
        })
      ).statusCode,
    ).toBe(400);
    const made = (
      await app.call("POST", "/projects/SD/sla-policies", "root", body)
    ).json();
    expect(
      (await app.call("GET", "/projects/SD/sla-policies", "root")).json(),
    ).toEqual([{ id: made.id, ...body }]);
    expect(
      (await app.call("DELETE", `/admin/calendars/${cal.id}`, "root"))
        .statusCode,
    ).toBe(409);
    expect(
      (await app.call("DELETE", `/sla-policies/${made.id}`, "root")).statusCode,
    ).toBe(204);
    expect(
      (await app.call("DELETE", `/admin/calendars/${cal.id}`, "root"))
        .statusCode,
    ).toBe(204);
  });
});
