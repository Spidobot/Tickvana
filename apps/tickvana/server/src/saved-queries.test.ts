import { csvCell, grantGlobal, type CoreDb } from "@tvn/core";
import { describeEachDb } from "@tvn/core/testing";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "./db/schema.js";
import { startTestApp, type TestApp } from "./testing.js";

it("writes safe CSV cells", () => {
  expect(csvCell("plain")).toBe("plain");
  expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
  expect(csvCell("zwei\nZeilen")).toBe('"zwei\nZeilen"');
  expect(csvCell(null)).toBe("");
  expect(csvCell(12.5)).toBe("12.5");
  expect(csvCell(-3)).toBe("-3");
  // Text that a spreadsheet would run as a formula is defused.
  expect(csvCell('=HYPERLINK("http://evil")')).toBe(
    '"\'=HYPERLINK(""http://evil"")"',
  );
  expect(csvCell("+1+1")).toBe("'+1+1");
  expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
});

describeEachDb<TrackDb>("saved queries", (t) => {
  let app: TestApp;
  let id: string;
  const SQL =
    "select issue_key, summary from issues where project_key = :project order by number";

  beforeAll(async () => {
    app = await startTestApp(t.url, { queryRole: true });
    await app.addUser("root", { admin: true });
    for (const name of ["mira", "jonas", "gast", "fremd"])
      await app.addUser(name);
    const core = app.db as unknown as Kysely<CoreDb>;
    // mira may write SQL; the others only run what is shared with them.
    await grantGlobal(core, "query.sql", "user", app.ids.mira!);
    await core
      .insertInto("core_group")
      .values({ id: "team", name: "Team", created_at: new Date() })
      .execute();
    await core
      .insertInto("core_group_member")
      .values([
        { group_id: "team", user_id: app.ids.mira! },
        { group_id: "team", user_id: app.ids.jonas! },
      ])
      .execute();

    await app.call("POST", "/projects", "root", {
      key: "WIT",
      name: "Werkstatt-IT",
    });
    const roles = Object.fromEntries(
      (await app.db.selectFrom("track_project_role").selectAll().execute()).map(
        (r) => [r.name, r.id],
      ),
    );
    for (const [user, role] of [
      ["mira", "Members"],
      ["jonas", "Members"],
      ["gast", "Viewers"],
    ]) {
      await app.call("PUT", "/projects/WIT/members", "root", {
        roleId: roles[role!],
        principalType: "user",
        principalId: app.ids[user!],
      });
    }
    const task = (
      await app.db
        .selectFrom("track_issue_type")
        .select("id")
        .where("name", "=", "Task")
        .executeTakeFirstOrThrow()
    ).id;
    for (const summary of ["Drucker", "=1+1", "Scanner, defekt"]) {
      await app.call("POST", "/issues", "mira", {
        projectKey: "WIT",
        type: task,
        fields: { summary },
      });
    }
  }, 180_000);
  afterAll(() => app?.close());

  const list = async (as: string) =>
    (await app.call("GET", "/core/queries", as))
      .json()
      .map((q: { name: string }) => q.name);

  it("lets people with the SQL permission save validated queries", async () => {
    const body = {
      name: "Offene Tickets",
      sql: SQL,
      params: { project: "WIT" },
    };
    expect(
      (await app.call("POST", "/core/queries", "jonas", body)).statusCode,
    ).toBe(403);
    expect(
      (
        await app.call("POST", "/core/queries", "mira", {
          ...body,
          sql: "delete from issues",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.call("POST", "/core/queries", "mira", {
          ...body,
          sql: "select * from core_session",
        })
      ).statusCode,
    ).toBe(400);

    const made = await app.call("POST", "/core/queries", "mira", body);
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({
      name: "Offene Tickets",
      visibility: "private",
      params: { project: "WIT" },
      mine: true,
      favorite: false,
    });
    id = made.json().id;
  });

  it("shares by visibility: private, group, everyone", async () => {
    expect(await list("mira")).toEqual(["Offene Tickets"]);
    expect(await list("jonas")).toEqual([]);
    expect(
      (await app.call("GET", `/core/queries/${id}`, "jonas")).statusCode,
    ).toBe(404);
    expect(
      (await app.call("POST", `/core/queries/${id}/run`, "jonas", {}))
        .statusCode,
    ).toBe(404);

    const patch = (as: string, body: object) =>
      app.call("PATCH", `/core/queries/${id}`, as, body);
    expect((await patch("mira", { visibility: "group" })).statusCode).toBe(400);
    expect(
      (await patch("mira", { visibility: "group", groupId: "nope" }))
        .statusCode,
    ).toBe(400);
    expect(
      (await patch("mira", { visibility: "group", groupId: "team" })).json(),
    ).toMatchObject({
      visibility: "group",
      groupId: "team",
      name: "Offene Tickets",
    });
    expect(await list("jonas")).toEqual(["Offene Tickets"]);
    expect(await list("gast")).toEqual([]);

    expect(
      (await patch("mira", { visibility: "global" })).json(),
    ).toMatchObject({ visibility: "global", groupId: null });
    expect(await list("gast")).toEqual(["Offene Tickets"]);
    // Seeing a query does not mean changing it.
    expect((await patch("jonas", { name: "Gekapert" })).statusCode).toBe(403);
    expect(
      (await app.call("DELETE", `/core/queries/${id}`, "jonas")).statusCode,
    ).toBe(403);
    // The owner without the SQL permission could rename, but not rewrite the SQL. An admin can.
    expect(
      (await patch("root", { name: "Offene Tickets WIT" })).json().name,
    ).toBe("Offene Tickets WIT");
    expect(
      (await patch("mira", { sql: "select * from track_issue" })).statusCode,
    ).toBe(400);
  });

  it("runs with the rights of whoever runs it", async () => {
    const run = async (as: string, body: object = {}) =>
      (await app.call("POST", `/core/queries/${id}/run`, as, body)).json();
    expect(
      (await run("jonas")).rows.map((r: { summary: string }) => r.summary),
    ).toEqual(["Drucker", "=1+1", "Scanner, defekt"]);
    // fremd sees the shared query, but none of the project's tickets.
    expect((await run("fremd")).rows).toEqual([]);
    // Stored parameters are defaults, the caller may override them.
    expect((await run("jonas", { params: { project: "NOPE" } })).rows).toEqual(
      [],
    );
    expect(await run("jonas", { limit: 1 })).toMatchObject({
      truncated: true,
      columns: ["issue_key", "summary"],
    });
  });

  it("exports CSV and JSON", async () => {
    const csv = await app.call("GET", `/core/queries/${id}/export`, "gast");
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toBe(
      "attachment; filename*=UTF-8''Offene%20Tickets%20WIT.csv",
    );
    expect(csv.body).toBe(
      '\uFEFFissue_key,summary\r\nWIT-1,Drucker\r\nWIT-2,\'=1+1\r\nWIT-3,"Scanner, defekt"\r\n',
    );

    const json = await app.call(
      "GET",
      `/core/queries/${id}/export?format=json`,
      "gast",
    );
    expect(json.json()).toEqual([
      { issue_key: "WIT-1", summary: "Drucker" },
      { issue_key: "WIT-2", summary: "=1+1" },
      { issue_key: "WIT-3", summary: "Scanner, defekt" },
    ]);
    expect(
      (await app.call("GET", `/core/queries/${id}/export`, null)).statusCode,
    ).toBe(401);
  });

  it("keeps favourites per person", async () => {
    expect(
      (await app.call("PUT", `/core/queries/${id}/favorite`, "jonas"))
        .statusCode,
    ).toBe(204);
    const of = async (as: string) =>
      (await app.call("GET", `/core/queries/${id}`, as)).json().favorite;
    expect([await of("jonas"), await of("mira")]).toEqual([true, false]);
    expect(
      (await app.call("DELETE", `/core/queries/${id}/favorite`, "jonas"))
        .statusCode,
    ).toBe(204);
    expect(await of("jonas")).toBe(false);
  });

  it("mails subscriptions once per chosen day, with the subscriber's rights", async () => {
    const sub = (as: string, body?: object) =>
      app.call(
        body ? "PUT" : "GET",
        `/core/queries/${id}/subscription`,
        as,
        body,
      );
    expect((await sub("jonas")).json()).toBeNull();
    expect(
      (await sub("jonas", { weekdays: [1, 2, 3, 4, 5], hour: 25 })).statusCode,
    ).toBe(400);
    // 2026-11-16 is a Monday. Users are in UTC.
    expect((await sub("jonas", { weekdays: [1, 3], hour: 8 })).statusCode).toBe(
      204,
    );
    expect((await sub("fremd", { weekdays: [1], hour: 8 })).statusCode).toBe(
      204,
    );
    expect((await sub("jonas")).json()).toEqual({ weekdays: [1, 3], hour: 8 });

    const send = (iso: string) =>
      app.running.savedQueries.sendSubscriptions(new Date(iso));
    const mails = async () =>
      (
        await app.db
          .selectFrom("core_job")
          .select("payload_json")
          .where("type", "=", "mail.send")
          .orderBy("id")
          .execute()
      ).map(
        (j) =>
          JSON.parse(j.payload_json) as {
            to: string;
            subject: string;
            body: string[];
            action: { url: string };
          },
      );

    expect(await send("2026-11-16T07:59:00Z")).toBe(0); // too early
    expect(await send("2026-11-16T08:05:00Z")).toBe(2);
    expect(await send("2026-11-16T09:00:00Z")).toBe(0); // already sent today
    expect(await send("2026-11-17T08:05:00Z")).toBe(0); // Tuesday: nobody chose it
    expect(await send("2026-11-18T12:00:00Z")).toBe(1); // Wednesday: only jonas

    const sent = await mails();
    const first = sent.find((m) => m.to === "jonas@example.org")!;
    expect(first).toMatchObject({
      subject: "Offene Tickets WIT",
      action: { url: `http://localhost/tickvana/queries/${id}` },
    });
    expect(first.body).toEqual([
      "3 Zeilen",
      "issue_key: WIT-1 · summary: Drucker",
      "issue_key: WIT-2 · summary: =1+1",
      "issue_key: WIT-3 · summary: Scanner, defekt",
    ]);
    // fremd has no access to the project: an empty result, not someone else's rows.
    expect(sent.find((m) => m.to === "fremd@example.org")!.body).toEqual([
      "0 Zeilen",
    ]);

    expect(
      (await app.call("DELETE", `/core/queries/${id}/subscription`, "jonas"))
        .statusCode,
    ).toBe(204);
    expect(await send("2026-11-23T08:05:00Z")).toBe(1);
  });

  it("deletes a query with its subscriptions", async () => {
    expect(
      (await app.call("DELETE", `/core/queries/${id}`, "mira")).statusCode,
    ).toBe(204);
    expect(await list("mira")).toEqual([]);
    expect(
      await (app.db as unknown as Kysely<CoreDb>)
        .selectFrom("core_query_subscription")
        .selectAll()
        .execute(),
    ).toEqual([]);
  });
});
