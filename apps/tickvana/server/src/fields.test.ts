import { describeEachDb } from "@tvn/core/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "./db/schema.js";
import {
  assertRequired,
  normalizeCustomValues,
  readCustomValues,
  resolveLayout,
  withDefaults,
  writeCustomValues,
  type Field,
} from "./fields.js";
import { startTestApp, type TestApp } from "./testing.js";

describeEachDb<TrackDb>("field engine", (t) => {
  let app: TestApp;
  let layoutId: string;
  const fieldIds: Record<string, string> = {};
  const optionIds: Record<string, string> = {};
  const issues = ["i1", "i2"];

  const fields = () =>
    // The fields this test makes, without the ones migrations bring (satisfaction).
    app.db
      .selectFrom("track_field")
      .selectAll()
      .where("key", "!=", "satisfaction")
      .execute() as Promise<Field[]>;
  const save = async (issueId: string, input: Record<string, unknown>) => {
    const all = await fields();
    const normalized = await normalizeCustomValues(app.db, all, input);
    await app.db
      .transaction()
      .execute((trx) => writeCustomValues(trx, issueId, normalized));
    return (await readCustomValues(app.db, all, [issueId])).get(issueId)!;
  };
  const rejects = async (input: Record<string, unknown>) =>
    normalizeCustomValues(app.db, await fields(), input).then(
      () => null,
      (e: { status?: number; details?: { field: string }[] }) =>
        e.status === 400 ? e.details!.map((d) => d.field) : Promise.reject(e),
    );

  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    await app.addUser("mira");
    await app.addUser("jonas");

    // One field of every type, created through the API.
    const types = [
      "text",
      "textarea",
      "url",
      "richtext",
      "number",
      "checkbox",
      "date",
      "datetime",
      "select",
      "multiselect",
      "cascade",
      "user",
      "multiuser",
      "group",
      "issue",
      "labels",
    ];
    for (const type of types) {
      const made = await app.call("POST", "/fields", "root", {
        key: `f_${type}`,
        name: `Feld ${type}`,
        type,
        ...(type === "number" && { config: { min: 0, max: 100 } }),
      });
      expect(made.statusCode, type).toBe(201);
      fieldIds[type] = made.json().id;
    }
    const option = async (type: string, value: string, parent?: string) => {
      const res = await app.call(
        "POST",
        `/fields/${fieldIds[type]}/options`,
        "root",
        { value, parentId: parent ? optionIds[parent] : null },
      );
      expect(res.statusCode, value).toBe(201);
      optionIds[value] = res
        .json()
        .options.find((o: { value: string }) => o.value === value).id;
    };
    for (const v of ["Halle 1", "Halle 2"]) await option("select", v);
    for (const v of ["Druck", "Netz", "Lager"]) await option("multiselect", v);
    await option("cascade", "Hardware");
    await option("cascade", "Software");
    await option("cascade", "Drucker", "Hardware");
    await option("cascade", "CAD", "Software");

    // Two tickets to hang values on.
    const d = await app.db
      .selectFrom("core_setting")
      .select("value_json")
      .where("key", "=", "track.defaults")
      .executeTakeFirstOrThrow();
    const defaults = JSON.parse(d.value_json);
    layoutId = defaults.fieldLayoutId;
    const now = new Date();
    await app.db
      .insertInto("track_project")
      .values({
        id: "p1",
        key: "WIT",
        name: "x",
        kind: "software",
        lead_id: app.ids.root!,
        permission_scheme_id: defaults.permissionSchemeId,
        notification_scheme_id: defaults.notificationSchemeId,
        issue_counter: 2,
        archived: false,
        created_at: now,
      })
      .execute();
    const type = await app.db
      .selectFrom("track_issue_type")
      .select("id")
      .where("name", "=", "Task")
      .executeTakeFirstOrThrow();
    const status = await app.db
      .selectFrom("track_status")
      .select("id")
      .where("category", "=", "todo")
      .executeTakeFirstOrThrow();
    for (const [n, id] of issues.entries()) {
      await app.db
        .insertInto("track_issue")
        .values({
          id,
          project_id: "p1",
          number: n + 1,
          key: `WIT-${n + 1}`,
          type_id: type.id,
          status_id: status.id,
          summary: "x",
          description_json: null,
          description_text: "",
          priority_id: defaults.priorityId,
          resolution_id: null,
          reporter_id: app.ids.root!,
          assignee_id: null,
          parent_id: null,
          security_level_id: null,
          rank: "m",
          due_date: null,
          estimate_sec: null,
          remaining_sec: null,
          spent_sec: 0,
          created_at: now,
          updated_at: now,
          resolved_at: null,
        })
        .execute();
    }
    await app.db
      .insertInto("core_group")
      .values({ id: "g1", name: "Technik", created_at: now })
      .execute();
  });
  afterAll(() => app?.close());

  it("round-trips a value of every field type", async () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Rolle prüfen" }],
        },
      ],
    };
    const input = {
      f_text: "Etikettendrucker",
      f_textarea: "Zeile 1\nZeile 2",
      f_url: "https://example.org/handbuch",
      f_richtext: doc,
      f_number: 42.5,
      f_checkbox: true,
      f_date: "2026-11-27",
      f_datetime: "2026-11-27T14:30:00.000Z",
      f_select: optionIds["Halle 2"],
      f_multiselect: [optionIds.Netz, optionIds.Druck],
      f_cascade: [optionIds.Hardware, optionIds.Drucker],
      f_user: app.ids.mira,
      f_multiuser: [app.ids.mira, app.ids.jonas],
      f_group: "g1",
      f_issue: "i2",
      f_labels: ["hardware", "halle-2"],
    };
    expect(await save("i1", input)).toEqual(input);

    // Stored typed: numbers and dates are sortable columns, rich text is searchable.
    const rows = await app.db
      .selectFrom("track_issue_field_value")
      .selectAll()
      .where("issue_id", "=", "i1")
      .execute();
    expect(rows.find((r) => r.field_id === fieldIds.number)!.value_number).toBe(
      42.5,
    );
    expect(
      rows.find((r) => r.field_id === fieldIds.date)!.value_date!.toISOString(),
    ).toBe("2026-11-27T00:00:00.000Z");
    expect(
      rows.find((r) => r.field_id === fieldIds.richtext && r.position === 0)!
        .value_text,
    ).toBe("Rolle prüfen");
    expect(
      rows
        .filter((r) => r.field_id === fieldIds.multiselect)
        .map((r) => r.position)
        .sort(),
    ).toEqual([0, 1]);

    // The other ticket is untouched and reads as empty.
    const other = (await readCustomValues(app.db, await fields(), ["i2"])).get(
      "i2",
    )!;
    expect(other).toMatchObject({
      f_text: null,
      f_checkbox: false,
      f_multiselect: [],
      f_labels: [],
      f_richtext: null,
    });
  });

  it("changes only the fields that are sent and clears on empty", async () => {
    const after = await save("i1", {
      f_text: "Neu",
      f_labels: [],
      f_number: null,
      f_checkbox: false,
    });
    expect(after).toMatchObject({
      f_text: "Neu",
      f_labels: [],
      f_number: null,
      f_checkbox: false,
      f_url: "https://example.org/handbuch",
      f_user: app.ids.mira,
    });
    // System keys and unknown keys are not this function's business.
    expect(await save("i1", { summary: "ignoriert", nope: 1 })).toMatchObject({
      f_text: "Neu",
    });
  });

  it("rejects wrong values and names the fields", async () => {
    const bad: Record<string, unknown> = {
      f_text: 5,
      f_url: "javascript:alert(1)",
      f_richtext: { type: "doc", content: [{ type: "iframe" }] },
      f_number: 101,
      f_checkbox: "ja",
      f_date: "2026-02-30",
      f_datetime: "gestern",
      f_select: optionIds.Netz, // option of another field
      f_multiselect: [optionIds.Netz, "nope"],
      f_cascade: [optionIds.Hardware, optionIds.CAD], // child of the other parent
      f_user: "nobody",
      f_multiuser: [app.ids.mira, "nobody"],
      f_group: "nope",
      f_issue: "nope",
      f_labels: ["mit leerzeichen"],
    };
    expect((await rejects(bad))!.sort()).toEqual(Object.keys(bad).sort());
    expect(await rejects({ f_number: "12" })).toEqual(["f_number"]);
    expect(await rejects({ f_cascade: [optionIds.Drucker] })).toEqual([
      "f_cascade",
    ]);
    expect(await rejects({ f_cascade: [optionIds.Software] })).toBeNull();
    expect(await rejects({ f_text: "x".repeat(501) })).toEqual(["f_text"]);
  });

  it("refuses disabled options and deactivated users for new values", async () => {
    const off = await app.call(
      "PATCH",
      `/fields/${fieldIds.select}/options/${optionIds["Halle 1"]}`,
      "root",
      { disabled: true },
    );
    expect(
      off
        .json()
        .options.find((o: { id: string }) => o.id === optionIds["Halle 1"])
        .disabled,
    ).toBe(true);
    expect(await rejects({ f_select: optionIds["Halle 1"] })).toEqual([
      "f_select",
    ]);

    await app.db
      .updateTable("core_user")
      .set({ active: false })
      .where("id", "=", app.ids.jonas!)
      .execute();
    expect(await rejects({ f_user: app.ids.jonas })).toEqual(["f_user"]);
    // What is already stored still reads back.
    expect(
      (await readCustomValues(app.db, await fields(), ["i1"])).get("i1")!
        .f_multiuser,
    ).toContain(app.ids.jonas);
  });

  it("manages field definitions through the API", async () => {
    const post = (body: object, as = "root") =>
      app.call("POST", "/fields", as, body);
    expect(
      (await post({ key: "x1", name: "X", type: "text" }, "mira")).statusCode,
    ).toBe(403);
    expect(
      (await post({ key: "Summary", name: "X", type: "text" })).statusCode,
    ).toBe(400);
    expect(
      (await post({ key: "summary", name: "X", type: "text" })).statusCode,
    ).toBe(409);
    expect(
      (await post({ key: "f_text", name: "X", type: "text" })).statusCode,
    ).toBe(409);
    expect(
      (await post({ key: "x2", name: "X", type: "hologram" })).statusCode,
    ).toBe(400);
    expect(
      (
        await post({
          key: "x3",
          name: "X",
          type: "number",
          config: { default: "viel" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post({
          key: "x4",
          name: "X",
          type: "select",
          config: { default: "o1" },
        })
      ).statusCode,
    ).toBe(400);

    const listed = (await app.call("GET", "/fields", "mira")).json();
    expect(
      listed.find((f: { key: string }) => f.key === "summary"),
    ).toMatchObject({ system: true, type: "text" });
    expect(
      listed.find((f: { key: string }) => f.key === "f_cascade").options,
    ).toHaveLength(4);

    const summary = listed.find((f: { key: string }) => f.key === "summary").id;
    expect(
      (await app.call("PATCH", `/fields/${summary}`, "root", { name: "Titel" }))
        .statusCode,
    ).toBe(409);
    expect(
      (await app.call("DELETE", `/fields/${summary}`, "root")).statusCode,
    ).toBe(409);

    // Defaults must be valid, and apply only when the caller sends nothing.
    const patched = await app.call(
      "PATCH",
      `/fields/${fieldIds.select}`,
      "root",
      { name: "Standort", config: { default: optionIds["Halle 2"] } },
    );
    expect(patched.json()).toMatchObject({
      name: "Standort",
      config: { default: optionIds["Halle 2"] },
    });
    expect(
      (
        await app.call("PATCH", `/fields/${fieldIds.select}`, "root", {
          config: { default: optionIds["Halle 1"] },
        })
      ).statusCode,
    ).toBe(400);
    const all = await fields();
    expect(withDefaults(all, {}).f_select).toBe(optionIds["Halle 2"]);
    expect(withDefaults(all, { f_select: null }).f_select).toBeNull();

    expect(
      (
        await app.call("POST", `/fields/${fieldIds.text}/options`, "root", {
          value: "x",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.call("POST", `/fields/${fieldIds.select}/options`, "root", {
          value: "Halle 2",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.call("POST", `/fields/${fieldIds.select}/options`, "root", {
          value: "Kind",
          parentId: optionIds["Halle 2"],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.call("POST", `/fields/${fieldIds.cascade}/options`, "root", {
          value: "Enkel",
          parentId: optionIds.Drucker,
        })
      ).statusCode,
    ).toBe(400);

    // Deleting a field removes its values everywhere.
    expect(
      (await app.call("DELETE", `/fields/${fieldIds.url}`, "root")).statusCode,
    ).toBe(204);
    expect(
      await app.db
        .selectFrom("track_issue_field_value")
        .select("issue_id")
        .where("field_id", "=", fieldIds.url!)
        .execute(),
    ).toEqual([]);
    expect(
      (await readCustomValues(app.db, await fields(), ["i1"])).get("i1"),
    ).not.toHaveProperty("f_url");
  });

  it("resolves layouts and checks required fields", async () => {
    const create = await resolveLayout(app.db, layoutId, "create");
    expect(create[0]).toMatchObject({
      field: { key: "summary" },
      required: true,
      hidden: false,
    });
    expect(() => assertRequired(create, { summary: "" })).toThrow(
      /Required: Summary/,
    );
    expect(() => assertRequired(create, { summary: "Drucker" })).not.toThrow();

    const copy = (
      await app.call("POST", "/field-layouts", "root", { name: "Störung" })
    ).json();
    expect(copy.items.create.length).toBe(create.length);
    const put = (items: object[], op = "create") =>
      app.call("PUT", `/field-layouts/${copy.id}/${op}`, "root", items);
    const summary = copy.items.create[0];

    expect(
      (await put([{ fieldId: fieldIds.select, required: true }])).statusCode,
    ).toBe(400);
    expect((await put([{ ...summary, required: false }])).statusCode).toBe(400);
    expect((await put([summary, summary])).statusCode).toBe(400);
    expect(
      (
        await put([
          summary,
          { fieldId: fieldIds.select, required: true, hidden: true },
        ])
      ).statusCode,
    ).toBe(400);
    expect((await put([summary, { fieldId: "nope" }])).statusCode).toBe(400);
    expect((await put([summary], "create")).statusCode).toBe(200);
    expect(
      (
        await app.call("PUT", `/field-layouts/${copy.id}/create`, "mira", [
          summary,
        ])
      ).statusCode,
    ).toBe(403);

    const saved = await put([
      summary,
      { fieldId: fieldIds.select, required: true, tab: "Ort" },
      { fieldId: fieldIds.number, hidden: true },
    ]);
    expect(saved.statusCode).toBe(200);
    const items = await resolveLayout(app.db, copy.id, "create");
    expect(
      items.map((i) => [i.field.key, i.required, i.hidden, i.tab]),
    ).toEqual([
      ["summary", true, false, ""],
      ["f_select", true, false, "Ort"],
      ["f_number", false, true, ""],
    ]);
    expect(() =>
      assertRequired(items, { summary: "x", f_select: null }),
    ).toThrow(/Standort/);
    expect(() =>
      assertRequired(items, { summary: "x", f_select: optionIds["Halle 2"] }),
    ).not.toThrow();
    // The original layout is unchanged, and view forms may drop the summary rule.
    expect((await resolveLayout(app.db, layoutId, "create")).length).toBe(
      create.length,
    );
    expect((await put([], "view")).statusCode).toBe(200);
  });
});
