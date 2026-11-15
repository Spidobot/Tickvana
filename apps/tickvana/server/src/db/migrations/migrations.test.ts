import { migrateCore } from "@tvn/core";
import { describeEachDb } from "@tvn/core/testing";
import { expect, it } from "vitest";
import type { TrackDb } from "../schema.js";
import {
  DEFAULTS_SETTING,
  PROJECT_PERMISSIONS,
  SYSTEM_FIELDS,
  type TrackDefaults,
} from "./0002_seed.js";
import { migrateTrack } from "./index.js";

describeEachDb<TrackDb>("track schema", (t) => {
  const defaults = async () => {
    const row = await t.db
      .selectFrom("core_setting")
      .select("value_json")
      .where("key", "=", DEFAULTS_SETTING)
      .executeTakeFirstOrThrow();
    return JSON.parse(row.value_json) as TrackDefaults;
  };

  it("has the same tables, columns and nullability on every database", async () => {
    await migrateCore(t);
    await migrateTrack(t);
    expect(await migrateTrack(t)).toEqual([]);
    const tables = await t.db.introspection.getTables();
    const shape = Object.fromEntries(
      tables
        .filter(
          (table) =>
            table.name.startsWith("track_") &&
            !table.name.includes("_migration"),
        )
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((table) => [
          table.name,
          table.columns
            .map((c) => `${c.name}${c.isNullable ? "?" : ""}`)
            .sort(),
        ]),
    );
    expect(Object.keys(shape)).toHaveLength(55);
    await expect(JSON.stringify(shape, null, 2) + "\n").toMatchFileSnapshot(
      "./track-schema.snap.json",
    );
  }, 180_000);

  it("seeds a usable default configuration", async () => {
    const d = await defaults();

    const statuses = await t.db
      .selectFrom("track_status")
      .selectAll()
      .execute();
    expect(statuses.map((s) => s.category).sort()).toEqual([
      "done",
      "in_progress",
      "todo",
    ]);
    const levels = await t.db
      .selectFrom("track_issue_type")
      .select("level")
      .orderBy("level")
      .execute();
    expect(levels.map((l) => l.level)).toEqual([-1, 0, 0, 0, 1]);

    // Every status of the workflow can be reached.
    const transitions = await t.db
      .selectFrom("track_workflow_transition")
      .selectAll()
      .where("workflow_id", "=", d.workflowId)
      .execute();
    expect(new Set(transitions.map((tr) => tr.to_status_id))).toEqual(
      new Set(statuses.map((s) => s.id)),
    );
    const doneId = statuses.find((s) => s.category === "done")!.id;
    const toDone = transitions.find((tr) => tr.to_status_id === doneId)!;
    expect(JSON.parse(toDone.rules_json).postFunctions[0].fn).toBe(
      "setResolution",
    );

    const all = await t.db.selectFrom("track_field").selectAll().execute();
    const fields = all.filter((f) => f.is_system);
    expect(fields.map((f) => f.key).sort()).toEqual(
      SYSTEM_FIELDS.map((f) => f.key).sort(),
    );
    // Besides the system fields, only the rating field of the service desk (0009).
    expect(all.filter((f) => !f.is_system).map((f) => [f.key, f.type])).toEqual(
      [["satisfaction", "number"]],
    );

    const required = await t.db
      .selectFrom("track_field_layout_item")
      .innerJoin(
        "track_field",
        "track_field.id",
        "track_field_layout_item.field_id",
      )
      .select(["operation", "key"])
      .where("layout_id", "=", d.fieldLayoutId)
      .where("required", "=", true)
      .execute();
    expect(required.map((r) => `${r.operation}:${r.key}`).sort()).toEqual([
      "create:summary",
      "edit:summary",
      "view:summary",
    ]);

    // Each permission is granted to someone, and only admins may administer or delete.
    const grants = await t.db
      .selectFrom("track_permission_grant")
      .selectAll()
      .where("scheme_id", "=", d.permissionSchemeId)
      .execute();
    expect(new Set(grants.map((g) => g.permission))).toEqual(
      new Set(PROJECT_PERMISSIONS),
    );
    for (const permission of ["project.administer", "issue.delete"]) {
      expect(
        grants
          .filter((g) => g.permission === permission)
          .map((g) => g.grantee_id),
      ).toEqual([d.roles.administrators]);
    }
    // Three roles, plus customers in the portal (0008).
    expect(
      grants.filter((g) => g.permission === "project.browse"),
    ).toHaveLength(4);
    expect(
      grants.some(
        (g) =>
          g.permission === "issue.edit" && g.grantee_id === d.roles.viewers,
      ),
    ).toBe(false);

    const priority = await t.db
      .selectFrom("track_priority")
      .select("name")
      .where("id", "=", d.priorityId)
      .executeTakeFirstOrThrow();
    expect(priority.name).toBe("Medium");
  });

  it("stores dates as calendar days, keeps issue keys unique and deletes dependants with the issue", async () => {
    const now = new Date();
    const d = await defaults();
    await t.db
      .insertInto("core_user")
      .values({
        id: "u1",
        email: "a@example.org",
        display_name: "A",
        password_hash: null,
        kind: "internal",
        active: true,
        locale: "de",
        timezone: "UTC",
        created_at: now,
        updated_at: now,
      })
      .execute();
    await t.db
      .insertInto("track_project")
      .values({
        id: "p1",
        key: "WIT",
        name: "Werkstatt-IT",
        kind: "software",
        lead_id: "u1",
        permission_scheme_id: d.permissionSchemeId,
        notification_scheme_id: d.notificationSchemeId,
        issue_counter: 0,
        archived: false,
        created_at: now,
      })
      .execute();
    const type = await t.db
      .selectFrom("track_issue_type")
      .select("id")
      .where("name", "=", "Task")
      .executeTakeFirstOrThrow();
    const status = await t.db
      .selectFrom("track_status")
      .select("id")
      .where("category", "=", "todo")
      .executeTakeFirstOrThrow();
    const issue = (id: string, number: number): TrackDb["track_issue"] => ({
      id,
      project_id: "p1",
      number,
      key: `WIT-${number}`,
      type_id: type.id,
      status_id: status.id,
      summary: "Drucker",
      description_json: null,
      description_text: "",
      priority_id: d.priorityId,
      resolution_id: null,
      reporter_id: "u1",
      assignee_id: null,
      parent_id: null,
      security_level_id: null,
      rank: "m",
      due_date: "2026-11-27",
      estimate_sec: null,
      remaining_sec: null,
      spent_sec: 0,
      created_at: now,
      updated_at: now,
      resolved_at: null,
      request_type_id: null,
    });
    await t.db.insertInto("track_issue").values(issue("i1", 1)).execute();
    const stored = await t.db
      .selectFrom("track_issue")
      .select("due_date")
      .where("id", "=", "i1")
      .executeTakeFirstOrThrow();
    expect(stored.due_date).toBe("2026-11-27");
    await expect(
      t.db.insertInto("track_issue").values(issue("i2", 1)).execute(),
    ).rejects.toThrow();

    const field = await t.db
      .selectFrom("track_field")
      .select("id")
      .where("key", "=", "summary")
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto("track_issue_field_value")
      .values({
        issue_id: "i1",
        field_id: field.id,
        position: 0,
        value_text: "x",
        value_number: 1.5,
        value_date: null,
        value_ref: null,
      })
      .execute();
    await t.db
      .insertInto("track_issue_label")
      .values({ issue_id: "i1", label: "hardware" })
      .execute();
    const value = await t.db
      .selectFrom("track_issue_field_value")
      .select("value_number")
      .executeTakeFirstOrThrow();
    expect(value.value_number).toBe(1.5);

    await t.db.deleteFrom("track_issue").where("id", "=", "i1").execute();
    expect(
      await t.db.selectFrom("track_issue_field_value").selectAll().execute(),
    ).toEqual([]);
    expect(
      await t.db.selectFrom("track_issue_label").selectAll().execute(),
    ).toEqual([]);
  });
});
