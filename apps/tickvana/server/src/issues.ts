// The issue service: create, read, edit with history, delete, move and type
// change. System fields live in track_issue and its link tables, custom fields
// go through the field engine. Both are addressed by field key in one map.
import {
  AppError,
  renderText,
  RichTextError,
  sanitizeDoc,
  uuidv7,
  type AuthUser,
} from "@tvn/core";
import type { Kysely } from "kysely";
import { issueTarget } from "./access.js";
import type { TrackContext } from "./context.js";
import type { TrackDb } from "./db/schema.js";
import { rankAtEnd } from "./rank.js";
import {
  assertRequired,
  normalizeCustomValues,
  readCustomValues,
  resolveLayout,
  withDefaults,
  writeCustomValues,
  type Field,
} from "./fields.js";

type Db = Kysely<TrackDb>;
type IssueRow = TrackDb["track_issue"];
type Values = Record<string, unknown>;

export interface Issue {
  id: string;
  key: string;
  projectId: string;
  number: number;
  /** All field values by field key, system and custom. */
  fields: Values;
  spentSec: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

const invalid = (field: string, message: string) =>
  new AppError(400, "validation", message, [{ field, message }]);
const notFound = () => new AppError(404, "not_found", "Not found");

/** System fields a caller may set. Status, type and resolution change through their own operations. */
const WRITABLE = [
  "summary",
  "description",
  "priority",
  "assignee",
  "reporter",
  "parent",
  "labels",
  "components",
  "fixVersions",
  "affectsVersions",
  "dueDate",
  "estimate",
  "remaining",
  "securityLevel",
] as const;
type Writable = (typeof WRITABLE)[number];

/** Validated system values: columns of track_issue plus the link tables. */
interface SystemChange {
  columns: Partial<IssueRow>;
  labels?: string[];
  components?: string[];
  fixVersions?: string[];
  affectsVersions?: string[];
}

const idList = (key: string, v: unknown): string[] => {
  if (
    !Array.isArray(v) ||
    v.length > 200 ||
    v.some((x) => typeof x !== "string")
  )
    throw invalid(key, `${key} must be a list of ids`);
  return [...new Set(v as string[])];
};
const seconds = (key: string, v: unknown): number | null => {
  if (v === null) return null;
  if (
    typeof v !== "number" ||
    !Number.isInteger(v) ||
    v < 0 ||
    v > 2_000_000_000
  )
    throw invalid(key, `${key} must be whole seconds`);
  return v;
};

export function createIssueService(ctx: TrackContext) {
  const { db, access } = ctx;

  const allFields = () =>
    db.selectFrom("track_field").selectAll().execute() as Promise<Field[]>;

  /** Validates the system fields present in `input` for an issue of `project`. */
  async function normalizeSystem(
    q: Db,
    project: { id: string },
    typeId: string,
    issueId: string | null,
    input: Values,
  ): Promise<SystemChange> {
    const change: SystemChange = { columns: {} };
    const has = (key: Writable) => Object.hasOwn(input, key);
    const activeUser = async (key: string, v: unknown) => {
      if (typeof v !== "string") throw invalid(key, `${key} must be a user id`);
      const user = await q
        .selectFrom("core_user")
        .select("id")
        .where("id", "=", v)
        .where("active", "=", true)
        .executeTakeFirst();
      if (!user) throw invalid(key, `${key} must be an active user`);
      return v;
    };
    const ofProject = async (
      key: string,
      table: "track_component" | "track_version",
      v: unknown,
    ) => {
      const ids = idList(key, v);
      if (ids.length === 0) return ids;
      const found = await q
        .selectFrom(table)
        .select("id")
        .where("project_id", "=", project.id)
        .where("id", "in", ids)
        .execute();
      if (found.length !== ids.length)
        throw invalid(key, `${key} must belong to this project`);
      return ids;
    };

    if (has("summary")) {
      const summary =
        typeof input.summary === "string" ? input.summary.trim() : "";
      if (!summary || summary.length > 500)
        throw invalid("summary", "Summary is required, at most 500 characters");
      change.columns.summary = summary;
    }
    if (has("description")) {
      if (input.description === null)
        Object.assign(change.columns, {
          description_json: null,
          description_text: "",
        });
      else {
        try {
          const doc = sanitizeDoc(input.description);
          Object.assign(change.columns, {
            description_json: JSON.stringify(doc),
            description_text: renderText(doc),
          });
        } catch (e) {
          throw invalid(
            "description",
            e instanceof RichTextError
              ? e.message
              : "Description must be a rich-text document",
          );
        }
      }
    }
    if (has("priority")) {
      const priority =
        typeof input.priority === "string"
          ? await q
              .selectFrom("track_priority")
              .select("id")
              .where("id", "=", input.priority)
              .executeTakeFirst()
          : undefined;
      if (!priority) throw invalid("priority", "Unknown priority");
      change.columns.priority_id = priority.id;
    }
    if (has("assignee"))
      change.columns.assignee_id =
        input.assignee === null
          ? null
          : await activeUser("assignee", input.assignee);
    if (has("reporter"))
      change.columns.reporter_id = await activeUser("reporter", input.reporter);
    if (has("dueDate")) {
      const v = input.dueDate;
      if (
        v !== null &&
        !(
          typeof v === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(v) &&
          !Number.isNaN(Date.parse(v)) &&
          new Date(v).toISOString().startsWith(v)
        )
      ) {
        throw invalid("dueDate", "Due date must be a date like 2026-11-27");
      }
      change.columns.due_date = v as string | null;
    }
    if (has("estimate"))
      change.columns.estimate_sec = seconds("estimate", input.estimate);
    if (has("remaining"))
      change.columns.remaining_sec = seconds("remaining", input.remaining);
    if (has("securityLevel")) {
      const v = input.securityLevel;
      if (v !== null) {
        const level =
          typeof v === "string"
            ? await q
                .selectFrom("track_security_level")
                .select("id")
                .where("id", "=", v)
                .where("project_id", "=", project.id)
                .executeTakeFirst()
            : undefined;
        if (!level) throw invalid("securityLevel", "Unknown security level");
      }
      change.columns.security_level_id = v as string | null;
    }
    if (has("parent")) {
      const v = input.parent;
      if (v !== null) await assertParent(q, project.id, typeId, issueId, v);
      change.columns.parent_id = v as string | null;
    }
    if (has("labels")) {
      const labels = idList("labels", input.labels).map((l) => l.trim());
      if (labels.some((l) => !/^\S{1,100}$/.test(l)))
        throw invalid("labels", "Labels must not be empty or contain spaces");
      change.labels = [...new Set(labels)];
    }
    if (has("components"))
      change.components = await ofProject(
        "components",
        "track_component",
        input.components,
      );
    if (has("fixVersions"))
      change.fixVersions = await ofProject(
        "fixVersions",
        "track_version",
        input.fixVersions,
      );
    if (has("affectsVersions"))
      change.affectsVersions = await ofProject(
        "affectsVersions",
        "track_version",
        input.affectsVersions,
      );
    return change;
  }

  /** A parent must be in the same project and one hierarchy level up: sub-task under standard, standard under epic. */
  async function assertParent(
    q: Db,
    projectId: string,
    typeId: string,
    issueId: string | null,
    parentId: unknown,
  ): Promise<void> {
    const parent =
      typeof parentId === "string"
        ? await q
            .selectFrom("track_issue as i")
            .innerJoin("track_issue_type as t", "t.id", "i.type_id")
            .select(["i.id", "i.project_id", "t.level"])
            .where("i.id", "=", parentId)
            .executeTakeFirst()
        : undefined;
    const type = await q
      .selectFrom("track_issue_type")
      .select("level")
      .where("id", "=", typeId)
      .executeTakeFirstOrThrow();
    if (!parent || parent.project_id !== projectId || parent.id === issueId)
      throw invalid(
        "parent",
        "Parent must be another ticket of the same project",
      );
    if (parent.level <= type.level)
      throw invalid(
        "parent",
        "Parent must be one level up: sub-tasks under tickets, tickets under epics",
      );
  }

  async function writeLinks(
    trx: Db,
    issueId: string,
    change: SystemChange,
  ): Promise<void> {
    if (change.labels) {
      await trx
        .deleteFrom("track_issue_label")
        .where("issue_id", "=", issueId)
        .execute();
      if (change.labels.length)
        await trx
          .insertInto("track_issue_label")
          .values(change.labels.map((label) => ({ issue_id: issueId, label })))
          .execute();
    }
    if (change.components) {
      await trx
        .deleteFrom("track_issue_component")
        .where("issue_id", "=", issueId)
        .execute();
      if (change.components.length)
        await trx
          .insertInto("track_issue_component")
          .values(
            change.components.map((component_id) => ({
              issue_id: issueId,
              component_id,
            })),
          )
          .execute();
    }
    for (const [kind, ids] of [
      ["fix", change.fixVersions],
      ["affects", change.affectsVersions],
    ] as const) {
      if (!ids) continue;
      await trx
        .deleteFrom("track_issue_version")
        .where("issue_id", "=", issueId)
        .where("kind", "=", kind)
        .execute();
      if (ids.length)
        await trx
          .insertInto("track_issue_version")
          .values(
            ids.map((version_id) => ({ issue_id: issueId, version_id, kind })),
          )
          .execute();
    }
  }

  /** Builds API issues from rows, loading links and custom values in batches. */
  async function present(q: Db, rows: IssueRow[]): Promise<Issue[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [labels, components, versions, custom] = await Promise.all([
      q
        .selectFrom("track_issue_label")
        .selectAll()
        .where("issue_id", "in", ids)
        .orderBy("label")
        .execute(),
      q
        .selectFrom("track_issue_component")
        .selectAll()
        .where("issue_id", "in", ids)
        .orderBy("component_id")
        .execute(),
      q
        .selectFrom("track_issue_version")
        .selectAll()
        .where("issue_id", "in", ids)
        .orderBy("version_id")
        .execute(),
      readCustomValues(q, await allFields(), ids),
    ]);
    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      projectId: r.project_id,
      number: r.number,
      fields: {
        summary: r.summary,
        description: r.description_json ? JSON.parse(r.description_json) : null,
        type: r.type_id,
        status: r.status_id,
        priority: r.priority_id,
        resolution: r.resolution_id,
        assignee: r.assignee_id,
        reporter: r.reporter_id,
        parent: r.parent_id,
        labels: labels.filter((l) => l.issue_id === r.id).map((l) => l.label),
        components: components
          .filter((c) => c.issue_id === r.id)
          .map((c) => c.component_id),
        fixVersions: versions
          .filter((v) => v.issue_id === r.id && v.kind === "fix")
          .map((v) => v.version_id),
        affectsVersions: versions
          .filter((v) => v.issue_id === r.id && v.kind === "affects")
          .map((v) => v.version_id),
        dueDate: r.due_date,
        estimate: r.estimate_sec,
        remaining: r.remaining_sec,
        securityLevel: r.security_level_id,
        ...custom.get(r.id),
      },
      spentSec: r.spent_sec,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      resolvedAt: r.resolved_at?.toISOString() ?? null,
    }));
  }

  /** Human-readable form of a value for the history ("from … to …"). */
  async function display(q: Db, field: Field, value: unknown): Promise<string> {
    if (
      value === null ||
      value === undefined ||
      (Array.isArray(value) && value.length === 0)
    )
      return "";
    const names = async (
      table:
        | "core_user"
        | "track_priority"
        | "track_component"
        | "track_version"
        | "track_field_option"
        | "track_issue"
        | "core_group"
        | "track_security_level"
        | "track_status"
        | "track_resolution",
      column: string,
      ids: string[],
    ) => {
      const rows = (await (
        q.selectFrom(table) as ReturnType<typeof q.selectFrom<"core_group">>
      )
        .select(["id", `${column} as label` as never])
        .where("id", "in", ids)
        .execute()) as unknown as { id: string; label: string }[];
      return ids
        .map((id) => rows.find((r) => r.id === id)?.label ?? id)
        .join(", ");
    };
    const ids = (Array.isArray(value) ? value : [value]) as string[];
    switch (field.type) {
      case "user":
      case "multiuser":
        return names("core_user", "display_name", ids);
      case "group":
        return names("core_group", "name", ids);
      case "priority":
        return names("track_priority", "name", ids);
      case "components":
        return names("track_component", "name", ids);
      case "versions":
        return names("track_version", "name", ids);
      case "securitylevel":
        return names("track_security_level", "name", ids);
      case "status":
        return names("track_status", "name", ids);
      case "resolution":
        return names("track_resolution", "name", ids);
      case "select":
      case "multiselect":
        return names("track_field_option", "value", ids);
      case "cascade":
        return (await names("track_field_option", "value", ids)).replace(
          ", ",
          " › ",
        );
      case "issue":
        return names("track_issue", "key", ids);
      case "richtext":
        return renderText(value as never).slice(0, 500);
      case "duration":
        return `${Math.round(((value as number) / 3600) * 100) / 100} h`;
      default:
        return Array.isArray(value) ? value.join(", ") : String(value);
    }
  }

  /** Writes one history entry for the fields whose value differs. Returns the changed keys. */
  async function recordChanges(
    trx: Db,
    issueId: string,
    actorId: string,
    fields: Field[],
    before: Values,
    after: Values,
    now: Date,
  ): Promise<string[]> {
    const changed = fields.filter(
      (f) =>
        Object.hasOwn(after, f.key) &&
        JSON.stringify(before[f.key] ?? null) !==
          JSON.stringify(after[f.key] ?? null),
    );
    if (changed.length === 0) return [];
    // In the order the caller sent them, not in whatever order the fields table returned.
    const sent = Object.keys(after);
    changed.sort((a, b) => sent.indexOf(a.key) - sent.indexOf(b.key));
    const changeId = uuidv7();
    await trx
      .insertInto("track_issue_change")
      .values({
        id: changeId,
        issue_id: issueId,
        actor_id: actorId,
        created_at: now,
      })
      .execute();
    const raw = (v: unknown) =>
      v === null || v === undefined
        ? null
        : typeof v === "string"
          ? v
          : JSON.stringify(v);
    const items = [];
    for (const f of changed) {
      items.push({
        id: uuidv7(),
        change_id: changeId,
        field_key: f.key,
        from_value: raw(before[f.key]),
        from_text: await display(trx, f, before[f.key]),
        to_value: raw(after[f.key]),
        to_text: await display(trx, f, after[f.key]),
      });
    }
    await trx.insertInto("track_issue_change_item").values(items).execute();
    return changed.map((f) => f.key);
  }

  /**
   * Loads an issue by key for a request. Tickets the user may not see answer
   * 404 like unknown ones; a missing `permission` on a visible ticket answers 403.
   */
  async function load(
    user: AuthUser | null,
    key: string,
    permission?: Parameters<typeof access.require>[1],
  ): Promise<IssueRow> {
    const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(key);
    let row = await db
      .selectFrom("track_issue")
      .selectAll()
      // Keys look like ABC-12; anything with the shape of a UUID is an id.
      .where((eb) =>
        isId ? eb("id", "=", key) : eb("key", "=", key.toUpperCase()),
      )
      .executeTakeFirst();
    // A key from before a move still finds the ticket (links in pages keep it).
    if (!row && !isId)
      row = await db
        .selectFrom("track_issue_change_item as ci")
        .innerJoin("track_issue_change as c", "c.id", "ci.change_id")
        .innerJoin("track_issue as i", "i.id", "c.issue_id")
        .selectAll("i")
        .where("ci.field_key", "=", "key")
        .where("ci.from_value", "=", key.toUpperCase())
        .orderBy("c.created_at", "desc")
        .executeTakeFirst();
    if (!row || !(await access.can(user, "project.browse", issueTarget(row)))) {
      throw user
        ? notFound()
        : new AppError(401, "unauthenticated", "Sign in required");
    }
    if (permission) await access.require(user, permission, issueTarget(row));
    return row;
  }

  /** Workflow and layout of an issue type in a project, or 400 when the project does not use that type. */
  async function mapping(q: Db, projectId: string, typeId: unknown) {
    const row =
      typeof typeId === "string"
        ? await q
            .selectFrom("track_project_issue_type")
            .selectAll()
            .where("project_id", "=", projectId)
            .where("issue_type_id", "=", typeId)
            .executeTakeFirst()
        : undefined;
    if (!row)
      throw invalid("type", "This project does not use that issue type");
    return row;
  }

  /** The status a new ticket starts in: the workflow's first status of category "todo", else its first status. */
  async function initialStatus(q: Db, workflowId: string): Promise<string> {
    const statuses = await q
      .selectFrom("track_workflow_status as ws")
      .innerJoin("track_status as s", "s.id", "ws.status_id")
      .select(["s.id", "s.category", "ws.x"])
      .where("ws.workflow_id", "=", workflowId)
      .orderBy("ws.x")
      .execute();
    const first = statuses.find((s) => s.category === "todo") ?? statuses[0];
    if (!first)
      throw new AppError(
        409,
        "conflict",
        "The workflow of this issue type has no status",
      );
    return first.id;
  }

  /** Takes the next number of a project. The row lock makes concurrent creates queue up, so numbers have no gaps and no duplicates. */
  async function nextNumber(trx: Db, projectId: string): Promise<number> {
    await trx
      .updateTable("track_project")
      .set((eb) => ({ issue_counter: eb("issue_counter", "+", 1) }))
      .where("id", "=", projectId)
      .execute();
    return (
      await trx
        .selectFrom("track_project")
        .select("issue_counter")
        .where("id", "=", projectId)
        .executeTakeFirstOrThrow()
    ).issue_counter;
  }

  return {
    load,
    /** Building blocks for the workflow engine, which changes tickets inside its own transaction. */
    internals: {
      allFields,
      mapping,
      normalizeSystem,
      writeLinks,
      present,
      recordChanges,
    },
    present: (rows: IssueRow[]) => present(db, rows),

    async get(user: AuthUser | null, key: string): Promise<Issue> {
      const row = await load(user, key);
      const issue = (await present(db, [row]))[0]!;
      if (user?.kind !== "customer") return issue;
      // Customers see the fields of the portal form and a few that frame every request.
      const layoutId =
        (row.request_type_id &&
          (
            await db
              .selectFrom("track_request_type")
              .select("field_layout_id")
              .where("id", "=", row.request_type_id)
              .executeTakeFirst()
          )?.field_layout_id) ??
        (await mapping(db, row.project_id, row.type_id)).field_layout_id;
      const portal = await db
        .selectFrom("track_field_layout_item as i")
        .innerJoin("track_field as f", "f.id", "i.field_id")
        .select("f.key")
        .where("i.layout_id", "=", layoutId)
        .where("i.operation", "=", "portal")
        .where("i.hidden", "=", false)
        .execute();
      const keep = new Set([
        "summary",
        "type",
        "status",
        "reporter",
        "resolution",
        ...portal.map((p) => p.key),
      ]);
      return {
        ...issue,
        fields: Object.fromEntries(
          Object.entries(issue.fields).filter(([k]) => keep.has(k)),
        ),
      };
    },

    async list(
      user: AuthUser | null,
      projectKey: string,
      limit: number,
      offset: number,
    ): Promise<Issue[]> {
      const project = await ctx.project(user, projectKey);
      const rows = await db
        .selectFrom("track_issue")
        .selectAll()
        .where("project_id", "=", project.id)
        .orderBy("rank")
        .limit(limit)
        .offset(offset)
        .execute();
      // Security levels can hide single tickets inside a visible project.
      const visible = [];
      for (const r of rows)
        if (
          (user?.kind !== "customer" && !r.security_level_id) ||
          (await access.can(user, "project.browse", issueTarget(r)))
        )
          visible.push(r);
      return present(db, visible);
    },

    async create(
      actor: AuthUser,
      projectKey: string,
      typeId: unknown,
      input: Values,
      /** Set by the portal: the request type the customer chose. */
      options: { requestTypeId?: string } = {},
    ): Promise<Issue> {
      const project = await ctx.project(actor, projectKey, "issue.create");
      const map = await mapping(db, project.id, typeId);
      const fields = await allFields();
      const d = await ctx.defaults();
      const values = withDefaults(fields, {
        priority: d.priorityId,
        reporter: actor.id,
        ...input,
      });
      if (
        Object.hasOwn(input, "assignee") &&
        input.assignee !== null &&
        input.assignee !== actor.id
      ) {
        await access.require(actor, "issue.assign", { projectId: project.id });
      }

      const id = uuidv7();
      const now = new Date();
      const system = await normalizeSystem(
        db,
        project,
        map.issue_type_id,
        null,
        values,
      );
      const custom = await normalizeCustomValues(db, fields, values);
      assertRequired(
        await resolveLayout(db, map.field_layout_id, "create"),
        values,
      );
      if (system.columns.summary === undefined)
        throw invalid("summary", "Summary is required, at most 500 characters");
      const statusId = await initialStatus(db, map.workflow_id);

      const row = await db.transaction().execute(async (trx) => {
        const number = await nextNumber(trx, project.id);
        const issue: IssueRow = {
          id,
          project_id: project.id,
          number,
          key: `${project.key}-${number}`,
          type_id: map.issue_type_id,
          status_id: statusId,
          summary: "",
          description_json: null,
          description_text: "",
          priority_id: d.priorityId,
          resolution_id: null,
          reporter_id: actor.id,
          assignee_id: null,
          parent_id: null,
          security_level_id: null,
          rank: await rankAtEnd(trx),
          due_date: null,
          estimate_sec: null,
          remaining_sec: null,
          spent_sec: 0,
          created_at: now,
          updated_at: now,
          resolved_at: null,
          ...system.columns,
          request_type_id: options.requestTypeId ?? null,
        };
        // Without an explicit remaining estimate, all of the estimate remains.
        if (issue.remaining_sec === null)
          issue.remaining_sec = issue.estimate_sec;
        await trx.insertInto("track_issue").values(issue).execute();
        await writeLinks(trx, id, system);
        await writeCustomValues(trx, id, custom);
        await ctx.emit(trx, {
          type: "issue.created",
          actorId: actor.id,
          entityType: "issue",
          entityId: id,
          payload: { key: issue.key, projectId: project.id },
        });
        return issue;
      });
      return (await present(db, [row]))[0]!;
    },

    async update(actor: AuthUser, key: string, input: Values): Promise<Issue> {
      const before = await load(actor, key, "issue.edit");
      for (const readOnly of ["status", "type", "resolution"]) {
        if (Object.hasOwn(input, readOnly))
          throw invalid(
            readOnly,
            `${readOnly} changes through its own operation, not through edit`,
          );
      }
      if (
        Object.hasOwn(input, "assignee") &&
        input.assignee !== before.assignee_id
      )
        await access.require(actor, "issue.assign", issueTarget(before));

      const fields = await allFields();
      const project = { id: before.project_id };
      const system = await normalizeSystem(
        db,
        project,
        before.type_id,
        before.id,
        input,
      );
      const custom = await normalizeCustomValues(db, fields, input);
      const map = await mapping(db, before.project_id, before.type_id);
      const old = (await present(db, [before]))[0]!;
      assertRequired(await resolveLayout(db, map.field_layout_id, "edit"), {
        ...old.fields,
        ...input,
      });

      const now = new Date();
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("track_issue")
          .set({ ...system.columns, updated_at: now })
          .where("id", "=", before.id)
          .execute();
        await writeLinks(trx, before.id, system);
        await writeCustomValues(trx, before.id, custom);
        const row = await trx
          .selectFrom("track_issue")
          .selectAll()
          .where("id", "=", before.id)
          .executeTakeFirstOrThrow();
        const after = (await present(trx, [row]))[0]!;
        const changed = await recordChanges(
          trx,
          before.id,
          actor.id,
          fields,
          old.fields,
          pick(after.fields, Object.keys(input)),
          now,
        );
        if (changed.length) {
          const type =
            changed.length === 1 && changed[0] === "assignee"
              ? "issue.assigned"
              : "issue.updated";
          await ctx.emit(trx, {
            type,
            actorId: actor.id,
            entityType: "issue",
            entityId: before.id,
            payload: { key: before.key, fields: changed },
          });
        }
      });
      return (
        await present(db, [
          await db
            .selectFrom("track_issue")
            .selectAll()
            .where("id", "=", before.id)
            .executeTakeFirstOrThrow(),
        ])
      )[0]!;
    },

    async remove(actor: AuthUser, key: string): Promise<void> {
      const issue = await load(actor, key, "issue.delete");
      await db.transaction().execute(async (trx) => {
        const child = await trx
          .selectFrom("track_issue")
          .select("key")
          .where("parent_id", "=", issue.id)
          .limit(1)
          .executeTakeFirst();
        if (child)
          throw new AppError(
            409,
            "conflict",
            `${child.key} still hangs under this ticket. Move or delete it first`,
          );
        await trx
          .deleteFrom("track_issue")
          .where("id", "=", issue.id)
          .execute();
        await ctx.emit(trx, {
          type: "issue.deleted",
          actorId: actor.id,
          entityType: "issue",
          entityId: issue.id,
          payload: { key: issue.key, summary: issue.summary },
        });
      });
    },

    /** Gives the ticket another type of the same project. Its status must exist in the new type's workflow. */
    async changeType(
      actor: AuthUser,
      key: string,
      typeId: unknown,
    ): Promise<Issue> {
      const issue = await load(actor, key, "issue.edit");
      const map = await mapping(db, issue.project_id, typeId);
      const fields = await allFields();
      const now = new Date();
      await db.transaction().execute(async (trx) => {
        if (issue.parent_id)
          await assertParent(
            trx,
            issue.project_id,
            map.issue_type_id,
            issue.id,
            issue.parent_id,
          );
        const level = (
          await trx
            .selectFrom("track_issue_type")
            .select("level")
            .where("id", "=", map.issue_type_id)
            .executeTakeFirstOrThrow()
        ).level;
        const tooHigh = await trx
          .selectFrom("track_issue as c")
          .innerJoin("track_issue_type as t", "t.id", "c.type_id")
          .select("c.key")
          .where("c.parent_id", "=", issue.id)
          .where("t.level", ">=", level)
          .limit(1)
          .executeTakeFirst();
        if (tooHigh)
          throw new AppError(
            409,
            "conflict",
            `${tooHigh.key} hangs under this ticket and would no longer fit below the new type`,
          );
        const hasStatus = await trx
          .selectFrom("track_workflow_status")
          .select("status_id")
          .where("workflow_id", "=", map.workflow_id)
          .where("status_id", "=", issue.status_id)
          .executeTakeFirst();
        if (!hasStatus)
          throw new AppError(
            409,
            "conflict",
            "The workflow of the new type does not have the ticket's current status",
          );

        await trx
          .updateTable("track_issue")
          .set({ type_id: map.issue_type_id, updated_at: now })
          .where("id", "=", issue.id)
          .execute();
        const typeField: Field = {
          ...fields.find((f) => f.key === "type")!,
          type: "issuetype",
        };
        const name = async (id: string) =>
          (
            await trx
              .selectFrom("track_issue_type")
              .select("name")
              .where("id", "=", id)
              .executeTakeFirstOrThrow()
          ).name;
        if (issue.type_id !== map.issue_type_id) {
          const changeId = uuidv7();
          await trx
            .insertInto("track_issue_change")
            .values({
              id: changeId,
              issue_id: issue.id,
              actor_id: actor.id,
              created_at: now,
            })
            .execute();
          await trx
            .insertInto("track_issue_change_item")
            .values({
              id: uuidv7(),
              change_id: changeId,
              field_key: typeField.key,
              from_value: issue.type_id,
              from_text: await name(issue.type_id),
              to_value: map.issue_type_id,
              to_text: await name(map.issue_type_id),
            })
            .execute();
          await ctx.emit(trx, {
            type: "issue.updated",
            actorId: actor.id,
            entityType: "issue",
            entityId: issue.id,
            payload: { key: issue.key, fields: ["type"] },
          });
        }
      });
      return this.get(actor, issue.key);
    },

    /**
     * Moves the ticket to another project. It gets a new key there and starts
     * in the target workflow's first status if its own does not exist. What
     * belongs to the old project (components, versions, security level, parent)
     * is dropped.
     */
    async move(
      actor: AuthUser,
      key: string,
      targetProjectKey: string,
      typeId?: unknown,
    ): Promise<Issue> {
      const issue = await load(actor, key, "issue.edit");
      const target = await ctx.project(actor, targetProjectKey, "issue.create");
      if (target.id === issue.project_id)
        throw new AppError(
          409,
          "conflict",
          "The ticket is already in this project",
        );
      const map = await mapping(db, target.id, typeId ?? issue.type_id);
      const now = new Date();

      const newKey = await db.transaction().execute(async (trx) => {
        const child = await trx
          .selectFrom("track_issue")
          .select("key")
          .where("parent_id", "=", issue.id)
          .limit(1)
          .executeTakeFirst();
        if (child)
          throw new AppError(
            409,
            "conflict",
            `${child.key} hangs under this ticket. Move it first`,
          );
        const keepsStatus = await trx
          .selectFrom("track_workflow_status")
          .select("status_id")
          .where("workflow_id", "=", map.workflow_id)
          .where("status_id", "=", issue.status_id)
          .executeTakeFirst();
        const number = await nextNumber(trx, target.id);
        const moved = `${target.key}-${number}`;
        await trx
          .deleteFrom("track_issue_component")
          .where("issue_id", "=", issue.id)
          .execute();
        await trx
          .deleteFrom("track_issue_version")
          .where("issue_id", "=", issue.id)
          .execute();
        await trx
          .updateTable("track_issue")
          .set({
            project_id: target.id,
            number,
            key: moved,
            type_id: map.issue_type_id,
            status_id: keepsStatus
              ? issue.status_id
              : await initialStatus(trx, map.workflow_id),
            ...(!keepsStatus && { resolution_id: null, resolved_at: null }),
            parent_id: null,
            security_level_id: null,
            rank: await rankAtEnd(trx),
            updated_at: now,
          })
          .where("id", "=", issue.id)
          .execute();
        const changeId = uuidv7();
        await trx
          .insertInto("track_issue_change")
          .values({
            id: changeId,
            issue_id: issue.id,
            actor_id: actor.id,
            created_at: now,
          })
          .execute();
        await trx
          .insertInto("track_issue_change_item")
          .values({
            id: uuidv7(),
            change_id: changeId,
            field_key: "key",
            from_value: issue.key,
            from_text: issue.key,
            to_value: moved,
            to_text: moved,
          })
          .execute();
        await ctx.emit(trx, {
          type: "issue.moved",
          actorId: actor.id,
          entityType: "issue",
          entityId: issue.id,
          payload: { from: issue.key, key: moved, projectId: target.id },
        });
        return moved;
      });
      return this.get(actor, newKey);
    },

    /** History of a ticket, newest first. */
    async history(user: AuthUser | null, key: string) {
      const issue = await load(user, key);
      const changes = await db
        .selectFrom("track_issue_change")
        .selectAll()
        .where("issue_id", "=", issue.id)
        .orderBy("id", "desc")
        .execute();
      if (changes.length === 0) return [];
      const items = await db
        .selectFrom("track_issue_change_item")
        .selectAll()
        .where(
          "change_id",
          "in",
          changes.map((c) => c.id),
        )
        .orderBy("id")
        .execute();
      return changes.map((c) => ({
        id: c.id,
        actorId: c.actor_id,
        createdAt: c.created_at.toISOString(),
        items: items
          .filter((i) => i.change_id === c.id)
          .map((i) => ({
            field: i.field_key,
            from: i.from_text ?? "",
            to: i.to_text ?? "",
          })),
      }));
    },
  };
}

const pick = (values: Values, keys: string[]): Values =>
  Object.fromEntries(
    keys.filter((k) => Object.hasOwn(values, k)).map((k) => [k, values[k]]),
  );

export type IssueService = ReturnType<typeof createIssueService>;
export { WRITABLE as WRITABLE_SYSTEM_FIELDS };
