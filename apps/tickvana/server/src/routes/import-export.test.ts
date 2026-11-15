import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "../db/schema.js";
import { startTestApp, type TestApp } from "../testing.js";
import { parseCsv } from "./import-export.js";

it("reads CSV with quotes, line breaks and either separator", () => {
  expect(parseCsv('\uFEFFa,b\r\n"x, ""y""",2\n"zwei\nZeilen",\n\n')).toEqual([
    ["a", "b"],
    ['x, "y"', "2"],
    ["zwei\nZeilen", ""],
  ]);
  expect(parseCsv("a;b\n1,5;2")).toEqual([
    ["a", "b"],
    ["1,5", "2"],
  ]);
});

describeEachDb<TrackDb>("CSV import and export", (t) => {
  let app: TestApp;
  const ids: Record<string, string> = {};
  const drain = async () => {
    while ((await app.running.queue.runDue()) > 0);
  };
  const importCsv = (
    as: string,
    csv: string,
    dryRun: boolean,
    mapping?: object,
  ) =>
    app.call("POST", "/projects/WIT/import", as, {
      csv,
      typeId: ids.Task,
      dryRun,
      mapping: mapping ?? {
        Titel: "summary",
        Typ: "type",
        Priorität: "priority",
        Bearbeiter: "assignee",
        Labels: "labels",
        Fällig: "dueDate",
        Beschreibung: "description",
      },
    });

  const CSV = [
    "Titel;Typ;Priorität;Bearbeiter;Labels;Fällig;Beschreibung",
    'Drucker;Bug;High;mira@example.org;hw dringend;2026-12-01;"Zeile eins\n\nZeile zwei"',
    "Scanner;;;Mira;;;",
  ].join("\r\n");

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    for (const name of ["mira", "gast"]) await app.addUser(name);
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
      ["gast", "Viewers"],
    ])
      await app.call("PUT", "/projects/WIT/members", "root", {
        roleId: roles[role!],
        principalType: "user",
        principalId: app.ids[user!],
      });
    for (const row of await app.db
      .selectFrom("track_issue_type")
      .selectAll()
      .execute())
      ids[row.name] = row.id;
    for (const row of await app.db
      .selectFrom("track_priority")
      .selectAll()
      .execute())
      ids[row.name] = row.id;
    await app.db
      .updateTable("core_user")
      .set({ email: "mira@example.org", display_name: "Mira" })
      .where("id", "=", app.ids.mira!)
      .execute();
  }, 180_000);
  afterAll(() => app?.close());

  it("checks everything in a dry run and reports rows that would fail", async () => {
    expect((await importCsv("gast", CSV, true)).statusCode).toBe(403);
    const ok = (await importCsv("mira", CSV, true)).json();
    expect(ok.rows).toBe(2);
    expect(ok.errors).toEqual([]);
    expect(ok.preview[0]).toEqual({
      label: "Row 2",
      type: ids.Bug,
      fields: {
        summary: "Drucker",
        priority: ids.High,
        assignee: app.ids.mira,
        labels: ["hw", "dringend"],
        dueDate: "2026-12-01",
        description: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Zeile eins" }],
            },
            {
              type: "paragraph",
              content: [{ type: "text", text: "Zeile zwei" }],
            },
          ],
        },
      },
    });
    expect(ok.preview[1]).toMatchObject({
      type: ids.Task,
      fields: { summary: "Scanner", assignee: app.ids.mira },
    });

    const bad = await importCsv("mira", CSV.replace("High", "Sofort"), false);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors).toEqual([
      { key: "Row 2", message: 'priority: "Sofort" is unknown' },
    ]);
    expect(
      (await importCsv("mira", CSV, true, { Typ: "status" })).statusCode,
    ).toBe(400);
    expect(
      await app.db.selectFrom("track_issue").select("id").execute(),
    ).toEqual([]);
  });

  it("imports as a job and reports what the service refused", async () => {
    const started = await importCsv("mira", CSV, false);
    expect(started.statusCode).toBe(202);
    await drain();
    const status = (
      await app.call("GET", `/bulk/${started.json().id}`, "mira")
    ).json();
    expect(status).toMatchObject({
      state: "finished",
      total: 2,
      done: 2,
      errors: [],
    });
    const made = (await app.call("GET", "/issues/WIT-1", "mira")).json();
    expect(made.fields).toMatchObject({
      summary: "Drucker",
      type: ids.Bug,
      priority: ids.High,
      reporter: app.ids.mira,
      labels: expect.arrayContaining(["dringend", "hw"]),
    });

    // A date the service rejects shows up as a row error, the rest is created.
    const second = await importCsv(
      "mira",
      "Titel;Fällig\nGut;\nSchlecht;2026-02-30",
      false,
      { Titel: "summary", Fällig: "dueDate" },
    );
    await drain();
    const result = (
      await app.call("GET", `/bulk/${second.json().id}`, "mira")
    ).json();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].key).toBe("Row 3");
  });

  it("exports what it imports", async () => {
    expect(
      (await app.call("GET", "/projects/WIT/export.csv", "mira")).statusCode,
    ).toBe(200);
    const res = await app.call("GET", "/projects/WIT/export.csv", "gast");
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    const [header, ...rows] = parseCsv(res.body);
    const col = (row: string[], key: string) => row[header!.indexOf(key)];
    const drucker = rows.find((r) => col(r, "summary") === "Drucker")!;
    expect(col(drucker, "key")).toBe("WIT-1");
    expect(col(drucker, "type")).toBe("Bug");
    expect(col(drucker, "priority")).toBe("High");
    expect(col(drucker, "assignee")).toBe("mira@example.org");
    expect(col(drucker, "description")).toBe("Zeile eins\n\nZeile zwei");

    // The export goes back in unchanged.
    const mapping = Object.fromEntries(
      [
        "summary",
        "type",
        "priority",
        "assignee",
        "labels",
        "dueDate",
        "description",
      ].map((k) => [k, k]),
    );
    const again = (
      await app.call("POST", "/projects/WIT/import", "mira", {
        csv: res.body,
        typeId: ids.Task,
        dryRun: true,
        mapping,
      })
    ).json();
    expect(again.errors).toEqual([]);
    expect(
      again.preview.find(
        (p: { fields: { summary: string } }) => p.fields.summary === "Drucker",
      ).fields,
    ).toMatchObject({
      priority: ids.High,
      assignee: app.ids.mira,
      dueDate: "2026-12-01",
    });
    expect(
      (await app.call("GET", "/projects/WIT/export.csv", null)).statusCode,
    ).toBe(401);
  });
});
