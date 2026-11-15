import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { uuidv7 } from "@tvn/core";
import type { TrackDb } from "../schema.js";

/** Where project creation finds the defaults seeded below. Stored in core_setting. */
export const DEFAULTS_SETTING = "track.defaults";
export interface TrackDefaults {
  workflowId: string;
  fieldLayoutId: string;
  permissionSchemeId: string;
  notificationSchemeId: string;
  priorityId: string;
  roles: { administrators: string; members: string; viewers: string };
}

/** Permissions a project's scheme can grant. T-2 registers the same keys with the permission core. */
export const PROJECT_PERMISSIONS = [
  "project.browse",
  "project.administer",
  "issue.create",
  "issue.edit",
  "issue.delete",
  "issue.assign",
  "issue.transition",
  "issue.comment",
  "issue.attach",
  "issue.worklog",
  "comment.internal",
] as const;

/** Fields every installation has. `column` names the track_issue column that stores the value. */
export const SYSTEM_FIELDS = [
  { key: "summary", name: "Summary", type: "text" },
  { key: "description", name: "Description", type: "richtext" },
  { key: "type", name: "Type", type: "issuetype" },
  { key: "status", name: "Status", type: "status" },
  { key: "priority", name: "Priority", type: "priority" },
  { key: "resolution", name: "Resolution", type: "resolution" },
  { key: "assignee", name: "Assignee", type: "user" },
  { key: "reporter", name: "Reporter", type: "user" },
  { key: "parent", name: "Parent", type: "issue" },
  { key: "labels", name: "Labels", type: "labels" },
  { key: "components", name: "Components", type: "components" },
  { key: "fixVersions", name: "Fix versions", type: "versions" },
  { key: "affectsVersions", name: "Affects versions", type: "versions" },
  { key: "dueDate", name: "Due date", type: "date" },
  { key: "estimate", name: "Original estimate", type: "duration" },
  { key: "remaining", name: "Remaining estimate", type: "duration" },
  { key: "securityLevel", name: "Security level", type: "securitylevel" },
] as const;

/**
 * What a fresh installation starts with: issue types, a three-status workflow,
 * priorities, resolutions, link types, system fields with a default layout,
 * roles and a permission scheme. Admins can change all of it afterwards.
 */
export const trackSeed: Migration = {
  async up(raw: Kysely<never>) {
    const db = raw as unknown as Kysely<TrackDb>;
    const named = <T extends object>(rows: T[]) =>
      rows.map((r) => ({ id: uuidv7(), ...r }));

    await db
      .insertInto("track_issue_type")
      .values(
        named([
          { name: "Epic", icon: "zap", level: 1 },
          { name: "Story", icon: "bookmark", level: 0 },
          { name: "Task", icon: "square-check", level: 0 },
          { name: "Bug", icon: "bug", level: 0 },
          { name: "Sub-task", icon: "corner-down-right", level: -1 },
        ]),
      )
      .execute();

    const [todo, doing, done] = named([
      { name: "To Do", category: "todo" as const },
      { name: "In Progress", category: "in_progress" as const },
      { name: "Done", category: "done" as const },
    ]) as [{ id: string }, { id: string }, { id: string }] &
      TrackDb["track_status"][];
    await db
      .insertInto("track_status")
      .values([todo, doing, done] as TrackDb["track_status"][])
      .execute();

    const priorities = named([
      { name: "Highest", position: 0, color: "#dc2626" },
      { name: "High", position: 1, color: "#ea580c" },
      { name: "Medium", position: 2, color: "#ca8a04" },
      { name: "Low", position: 3, color: "#2563eb" },
      { name: "Lowest", position: 4, color: "#6b6b6b" },
    ]);
    await db.insertInto("track_priority").values(priorities).execute();

    const resolutions = named([
      { name: "Done" },
      { name: "Won't Do" },
      { name: "Duplicate" },
      { name: "Cannot Reproduce" },
    ]);
    await db.insertInto("track_resolution").values(resolutions).execute();

    await db
      .insertInto("track_link_type")
      .values(
        named([
          { name: "Blocks", outward: "blocks", inward: "is blocked by" },
          { name: "Relates", outward: "relates to", inward: "relates to" },
          {
            name: "Duplicates",
            outward: "duplicates",
            inward: "is duplicated by",
          },
          { name: "Clones", outward: "clones", inward: "is cloned by" },
        ]),
      )
      .execute();

    // Fields and the default layout.
    const fields = named(
      SYSTEM_FIELDS.map((f) => ({ ...f, is_system: true, config_json: "{}" })),
    );
    await db.insertInto("track_field").values(fields).execute();
    const fieldId = (key: (typeof SYSTEM_FIELDS)[number]["key"]) =>
      fields.find((f) => f.key === key)!.id;

    const layoutId = uuidv7();
    await db
      .insertInto("track_field_layout")
      .values({ id: layoutId, name: "Standard" })
      .execute();
    const onForms = [
      "summary",
      "description",
      "priority",
      "assignee",
      "labels",
      "components",
      "fixVersions",
      "dueDate",
      "estimate",
      "parent",
    ] as const;
    const onView = [
      ...onForms,
      "reporter",
      "status",
      "resolution",
      "affectsVersions",
      "remaining",
    ] as const;
    const items = (
      operation: "create" | "edit" | "view",
      keys: readonly (typeof SYSTEM_FIELDS)[number]["key"][],
    ) =>
      keys.map((key, position) => ({
        layout_id: layoutId,
        operation,
        field_id: fieldId(key),
        position,
        tab: "",
        required: key === "summary",
        hidden: false,
      }));
    await db
      .insertInto("track_field_layout_item")
      .values([
        ...items("create", onForms),
        ...items("edit", onForms),
        ...items("view", onView),
      ])
      .execute();

    // An open workflow: every status is reachable from every other one.
    const workflowId = uuidv7();
    await db
      .insertInto("track_workflow")
      .values({ id: workflowId, name: "Standard" })
      .execute();
    await db
      .insertInto("track_workflow_status")
      .values(
        [todo, doing, done].map((s, i) => ({
          workflow_id: workflowId,
          status_id: s.id,
          x: 80 + i * 240,
          y: 120,
        })),
      )
      .execute();
    const doneResolution = resolutions[0]!.id;
    await db
      .insertInto("track_workflow_transition")
      .values(
        named([
          { to: todo, name: "To Do", post: [{ fn: "clearResolution" }] },
          { to: doing, name: "Start", post: [{ fn: "clearResolution" }] },
          {
            to: done,
            name: "Done",
            post: [{ fn: "setResolution", resolutionId: doneResolution }],
          },
        ]).map(({ id, to, name, post }) => ({
          id,
          workflow_id: workflowId,
          from_status_id: null,
          to_status_id: to.id,
          name,
          field_layout_id: null,
          rules_json: JSON.stringify({
            conditions: [],
            validators: [],
            postFunctions: post,
          }),
        })),
      )
      .execute();

    // Roles and who may do what by default.
    const [administrators, members, viewers] = named([
      { name: "Administrators" },
      { name: "Members" },
      { name: "Viewers" },
    ]) as [
      { id: string; name: string },
      { id: string; name: string },
      { id: string; name: string },
    ];
    await db
      .insertInto("track_project_role")
      .values([administrators, members, viewers])
      .execute();

    const permissionSchemeId = uuidv7();
    await db
      .insertInto("track_permission_scheme")
      .values({ id: permissionSchemeId, name: "Standard" })
      .execute();
    const adminOnly = new Set(["project.administer", "issue.delete"]);
    const grants = PROJECT_PERMISSIONS.flatMap((permission) => {
      const roles = adminOnly.has(permission)
        ? [administrators]
        : permission === "project.browse"
          ? [administrators, members, viewers]
          : [administrators, members];
      return roles.map((role) => ({
        id: uuidv7(),
        scheme_id: permissionSchemeId,
        permission,
        grantee_type: "role" as const,
        grantee_id: role.id,
      }));
    });
    await db.insertInto("track_permission_grant").values(grants).execute();

    const notificationSchemeId = uuidv7();
    await db
      .insertInto("track_notification_scheme")
      .values({ id: notificationSchemeId, name: "Standard" })
      .execute();
    await db
      .insertInto("track_notification_rule")
      .values(
        [
          "issue.created",
          "issue.updated",
          "issue.transitioned",
          "issue.commented",
          "issue.assigned",
        ].flatMap((event_type) =>
          ["assignee", "reporter", "watchers"].map((recipient_type) => ({
            id: uuidv7(),
            scheme_id: notificationSchemeId,
            event_type,
            recipient_type,
            recipient_id: null,
          })),
        ),
      )
      .execute();

    const defaults: TrackDefaults = {
      workflowId,
      fieldLayoutId: layoutId,
      permissionSchemeId,
      notificationSchemeId,
      priorityId: priorities[2]!.id,
      roles: {
        administrators: administrators.id,
        members: members.id,
        viewers: viewers.id,
      },
    };
    await db
      .insertInto("core_setting")
      .values({
        key: DEFAULTS_SETTING,
        value_json: JSON.stringify(defaults),
        updated_at: new Date(),
      })
      .execute();
  },
};
