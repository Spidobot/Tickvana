// Tickvana's virtual tables for the SQL query engine (CONCEPT.md §3). Each one
// is a SELECT that already contains only what the asking user may see: tickets
// of projects they can browse, minus tickets behind a security level, minus
// internal comments they may not read. Everything else hangs off `issues`.
import type {
  AppContext,
  AuthUser,
  BuildContext,
  CatalogColumn,
  CoreDb,
  VirtualTable,
} from "@tvn/core";
import {
  sql,
  type Expression,
  type ExpressionBuilder,
  type Kysely,
  type SqlBool,
} from "kysely";
import type { TrackContext } from "./context.js";
import type { TrackDb } from "./db/schema.js";
import type { Field } from "./fields.js";

const col = (
  name: string,
  type: string,
  description: string,
): CatalogColumn => ({ name, type, description });
const USER_COLUMNS = ["id", "display_name"];
const never = sql<SqlBool>`1 = 0`;

/** How a custom field's value appears as one SQL column. */
const CF_KIND: Record<
  string,
  {
    type: string;
    source: "text" | "number" | "date" | "option" | "user" | "group" | "issue";
    multi?: boolean;
  }
> = {
  text: { type: "text", source: "text" },
  textarea: { type: "text", source: "text" },
  url: { type: "text", source: "text" },
  richtext: { type: "text", source: "text" }, // row 0 holds the plain text
  number: { type: "number", source: "number" },
  checkbox: { type: "number", source: "number" },
  date: { type: "datetime", source: "date" },
  datetime: { type: "datetime", source: "date" },
  select: { type: "text", source: "option" },
  multiselect: { type: "text", source: "option", multi: true },
  cascade: { type: "text", source: "option", multi: true },
  user: { type: "text", source: "user" },
  multiuser: { type: "text", source: "user", multi: true },
  group: { type: "text", source: "group" },
  issue: { type: "text", source: "issue" },
  labels: { type: "text", source: "text", multi: true },
};

export function installTrackQueryTables(
  ctx: TrackContext,
  app: AppContext,
): void {
  const { db, access } = ctx;
  const { dialect } = app.database;

  const customFields = async () =>
    (
      (await db
        .selectFrom("track_field")
        .selectAll()
        .where("is_system", "=", false)
        .orderBy("key")
        .execute()) as Field[]
    ).filter((f) => CF_KIND[f.type]);

  /**
   * One column for a custom field: a correlated subquery on the value rows of
   * the ticket `i`. Written as an SQL fragment: table and column names are
   * fixed here, the field id is bound.
   */
  function customColumn(field: Field): Expression<unknown> {
    const kind = CF_KIND[field.type]!;
    const joined = {
      option: ["track_field_option", "value"],
      user: ["core_user", "display_name"],
      group: ["core_group", "name"],
      issue: ["track_issue", "key"],
    } as const;
    const target =
      kind.source in joined
        ? joined[kind.source as keyof typeof joined]
        : undefined;
    const join = target
      ? sql` join ${sql.table(target[0])} as o on o.id = v.value_ref`
      : sql``;
    const value = target
      ? sql.ref(`o.${target[1]}`)
      : sql.ref(
          kind.source === "number"
            ? "v.value_number"
            : kind.source === "date"
              ? "v.value_date"
              : "v.value_text",
        );
    const rows = sql`from track_issue_field_value as v${join} where v.issue_id = i.id and v.field_id = ${field.id}`;
    // Several values become one comma-separated text, in their stored order.
    return kind.multi
      ? sql`select ${dialect.stringAgg(value, ", ", sql.ref("v.position"))} ${rows}`
      : sql`select ${value} ${rows} and v.position = 0`;
  }

  /** WHERE for "tickets this user may see", on the alias `i`. */
  async function visibleIssues(user: AuthUser | null) {
    const [projectIds, levels] = await Promise.all([
      access.visibleProjectIds(user),
      access.securityLevels(user),
    ]);
    return (
      eb: ExpressionBuilder<TrackDb & { i: TrackDb["track_issue"] }, "i">,
    ) => {
      if (projectIds.length === 0) return never;
      const inProject = eb("i.project_id", "in", projectIds);
      if (levels.all) return inProject;
      const through = (ids: string[], extra?: Expression<SqlBool>) =>
        ids.length
          ? [
              extra
                ? eb.and([eb("i.security_level_id", "in", ids), extra])
                : eb("i.security_level_id", "in", ids),
            ]
          : [];
      return eb.and([
        inProject,
        eb.or([
          eb("i.security_level_id", "is", null),
          ...through(levels.always),
          ...(user
            ? through(levels.asReporter, eb("i.reporter_id", "=", user.id))
            : []),
          ...(user
            ? through(levels.asAssignee, eb("i.assignee_id", "=", user.id))
            : []),
        ]),
      ]);
    };
  }

  const issueColumns: CatalogColumn[] = [
    col("id", "text", "Ticket id"),
    col("issue_key", "text", "Key like ABC-12"),
    col("project_id", "text", "Project id"),
    col("project_key", "text", "Project key"),
    col("number", "number", "Number inside the project"),
    col("type", "text", "Issue type name"),
    col("status", "text", "Status name"),
    col("status_category", "text", "todo, in_progress or done"),
    col("priority", "text", "Priority name"),
    col(
      "priority_position",
      "number",
      "Sort position of the priority, 0 is highest",
    ),
    col("resolution", "text", "Resolution name, empty while open"),
    col("summary", "text", "Summary"),
    col("description", "text", "Description as plain text"),
    col("reporter_id", "text", "User id of the reporter"),
    col("reporter", "text", "Name of the reporter"),
    col("assignee_id", "text", "User id of the assignee"),
    col("assignee", "text", "Name of the assignee"),
    col("parent_id", "text", "Id of the parent ticket"),
    col("rank", "text", "Manual order, sort ascending"),
    col("due_date", "date", "Due date"),
    col("estimate_sec", "number", "Original estimate in seconds"),
    col("remaining_sec", "number", "Remaining estimate in seconds"),
    col("spent_sec", "number", "Logged time in seconds"),
    col("created_at", "datetime", "When the ticket was created"),
    col("updated_at", "datetime", "Last change"),
    col("resolved_at", "datetime", "When it reached a done status"),
  ];

  const issues: VirtualTable = {
    name: "issues",
    description:
      "Tickets you may see. Custom fields are columns named cf_<key>",
    columns: async () => [
      ...issueColumns,
      ...(await customFields()).map((f) =>
        col(`cf_${f.key}`, CF_KIND[f.type]!.type, f.name),
      ),
    ],
    reads: [
      { table: "track_issue" },
      { table: "track_project" },
      { table: "track_issue_type" },
      { table: "track_status" },
      { table: "track_priority" },
      { table: "track_resolution" },
      { table: "track_issue_field_value" },
      { table: "track_field_option" },
      { table: "core_user", columns: USER_COLUMNS },
      { table: "core_group", columns: ["id", "name"] },
    ],
    async build({ user, customColumns, star }: BuildContext) {
      const fields = (await customFields()).filter(
        (f) => star || customColumns.has(`cf_${f.key}`),
      );
      return db
        .selectFrom("track_issue as i")
        .innerJoin("track_project as p", "p.id", "i.project_id")
        .innerJoin("track_issue_type as t", "t.id", "i.type_id")
        .innerJoin("track_status as s", "s.id", "i.status_id")
        .innerJoin("track_priority as pr", "pr.id", "i.priority_id")
        .leftJoin("track_resolution as r", "r.id", "i.resolution_id")
        .innerJoin("core_user as rep", "rep.id", "i.reporter_id")
        .leftJoin("core_user as asg", "asg.id", "i.assignee_id")
        .select([
          "i.id",
          "i.key as issue_key",
          "i.project_id",
          "p.key as project_key",
          "i.number",
          "t.name as type",
          "s.name as status",
          "s.category as status_category",
          "pr.name as priority",
          "pr.position as priority_position",
          "r.name as resolution",
          "i.summary",
          "i.description_text as description",
          "i.reporter_id",
          "rep.display_name as reporter",
          "i.assignee_id",
          "asg.display_name as assignee",
          "i.parent_id",
          "i.rank",
          "i.due_date",
          "i.estimate_sec",
          "i.remaining_sec",
          "i.spent_sec",
          "i.created_at",
          "i.updated_at",
          "i.resolved_at",
        ])
        .select(fields.map((f) => sql`(${customColumn(f)})`.as(`cf_${f.key}`)))
        .where(await visibleIssues(user));
    },
  };

  /** Rows of a child table whose ticket is in `issues`. */
  const ofVisibleIssue = sql<SqlBool>`issue_id in (select id from issues)`;
  const child = (table: Omit<VirtualTable, "needs">): VirtualTable => ({
    ...table,
    needs: ["issues"],
  });

  const tables: VirtualTable[] = [
    issues,
    {
      name: "projects",
      description: "Projects you may browse",
      columns: [
        col("id", "text", "Project id"),
        col("project_key", "text", "Key"),
        col("name", "text", "Name"),
        col("kind", "text", "software, service or business"),
        col("lead_id", "text", "User id of the lead"),
        col("archived", "boolean", "True when archived"),
        col("created_at", "datetime", "When it was created"),
      ],
      reads: [{ table: "track_project" }],
      async build({ user }) {
        const ids = await access.visibleProjectIds(user);
        const q = db
          .selectFrom("track_project")
          .select([
            "id",
            "key as project_key",
            "name",
            "kind",
            "lead_id",
            "archived",
            "created_at",
          ]);
        return ids.length ? q.where("id", "in", ids) : q.where(never);
      },
    },
    child({
      name: "comments",
      description:
        "Comments on tickets. Internal ones only where you may read them",
      columns: [
        col("id", "text", "Comment id"),
        col("issue_id", "text", "Ticket id"),
        col("author_id", "text", "User id"),
        col("author", "text", "Name of the author"),
        col("body", "text", "Comment as plain text"),
        col("visibility", "text", "public or internal"),
        col("created_at", "datetime", "When it was written"),
        col("updated_at", "datetime", "Last edit"),
      ],
      reads: [
        { table: "track_comment" },
        { table: "track_issue" },
        { table: "core_user", columns: USER_COLUMNS },
      ],
      async build({ user }) {
        // ponytail: one permission check per visible project. Fine for dozens of projects, batch it for thousands.
        const internalIn: string[] = [];
        for (const projectId of await access.visibleProjectIds(user)) {
          if (await access.can(user, "comment.internal", { projectId }))
            internalIn.push(projectId);
        }
        return db
          .selectFrom("track_comment as c")
          .innerJoin("track_issue as ci", "ci.id", "c.issue_id")
          .innerJoin("core_user as u", "u.id", "c.author_id")
          .select([
            "c.id",
            "c.issue_id",
            "c.author_id",
            "u.display_name as author",
            "c.body_text as body",
            "c.visibility",
            "c.created_at",
            "c.updated_at",
          ])
          .where(sql<SqlBool>`c.issue_id in (select id from issues)`)
          .where((eb) =>
            eb.or([
              eb("c.visibility", "=", "public"),
              ...(internalIn.length
                ? [eb("ci.project_id", "in", internalIn)]
                : []),
            ]),
          );
      },
    }),
    child({
      name: "issue_history",
      description: "Every field change of a ticket, one row per changed field",
      columns: [
        col("issue_id", "text", "Ticket id"),
        col("actor_id", "text", "User id"),
        col("actor", "text", "Who changed it"),
        col("field", "text", "Field key"),
        col("from_text", "text", "Value before"),
        col("to_text", "text", "Value after"),
        col("changed_at", "datetime", "When"),
      ],
      reads: [
        { table: "track_issue_change" },
        { table: "track_issue_change_item" },
        { table: "core_user", columns: USER_COLUMNS },
      ],
      build: async () =>
        db
          .selectFrom("track_issue_change as ch")
          .innerJoin("track_issue_change_item as it", "it.change_id", "ch.id")
          .innerJoin("core_user as u", "u.id", "ch.actor_id")
          .select([
            "ch.issue_id",
            "ch.actor_id",
            "u.display_name as actor",
            "it.field_key as field",
            "it.from_text",
            "it.to_text",
            "ch.created_at as changed_at",
          ])
          .where(sql<SqlBool>`ch.issue_id in (select id from issues)`),
    }),
    child({
      name: "sla_cycles",
      description: "SLA clocks of tickets",
      columns: [
        col("id", "text", "Clock id"),
        col("issue_id", "text", "Ticket id"),
        col("policy", "text", "SLA policy"),
        col("started_at", "datetime", "When the clock started"),
        col("due_at", "datetime", "When the goal runs out"),
        col("stopped_at", "datetime", "When the clock stopped"),
        col("paused", "boolean", "Paused right now"),
        col("breached", "boolean", "Goal missed"),
      ],
      reads: [{ table: "track_sla_cycle" }, { table: "track_sla_policy" }],
      build: async () =>
        db
          .selectFrom("track_sla_cycle as c")
          .innerJoin("track_sla_policy as p", "p.id", "c.policy_id")
          .select((eb) => [
            "c.id",
            "c.issue_id",
            "p.name as policy",
            "c.started_at",
            "c.due_at",
            "c.stopped_at",
            eb("c.paused_at", "is not", null).as("paused"),
            "c.breached",
          ])
          .where(sql<SqlBool>`c.issue_id in (select id from issues)`),
    }),
    child({
      name: "worklogs",
      description: "Logged work",
      columns: [
        col("id", "text", "Work log id"),
        col("issue_id", "text", "Ticket id"),
        col("author_id", "text", "User id"),
        col("author", "text", "Who logged it"),
        col("started_at", "datetime", "When the work started"),
        col("seconds", "number", "Duration in seconds"),
        col("note", "text", "Note"),
      ],
      reads: [
        { table: "track_worklog" },
        { table: "core_user", columns: USER_COLUMNS },
      ],
      build: async () =>
        db
          .selectFrom("track_worklog as w")
          .innerJoin("core_user as u", "u.id", "w.author_id")
          .select([
            "w.id",
            "w.issue_id",
            "w.author_id",
            "u.display_name as author",
            "w.started_at",
            "w.seconds",
            "w.note",
          ])
          .where(sql<SqlBool>`w.issue_id in (select id from issues)`),
    }),
    child({
      name: "issue_links",
      description:
        "Links between tickets. Only links whose both ends you may see",
      columns: [
        col("id", "text", "Link id"),
        col("link_type", "text", "Type name, e.g. Blocks"),
        col("from_issue_id", "text", "Ticket the link starts at"),
        col("to_issue_id", "text", "Ticket the link points to"),
      ],
      reads: [{ table: "track_issue_link" }, { table: "track_link_type" }],
      build: async () =>
        db
          .selectFrom("track_issue_link as l")
          .innerJoin("track_link_type as lt", "lt.id", "l.type_id")
          .select([
            "l.id",
            "lt.name as link_type",
            "l.from_issue_id",
            "l.to_issue_id",
          ])
          .where(sql<SqlBool>`l.from_issue_id in (select id from issues)`)
          .where(sql<SqlBool>`l.to_issue_id in (select id from issues)`),
    }),
    child({
      name: "issue_labels",
      description: "Labels, one row per ticket and label",
      columns: [
        col("issue_id", "text", "Ticket id"),
        col("label", "text", "Label"),
      ],
      reads: [{ table: "track_issue_label" }],
      build: async () =>
        db
          .selectFrom("track_issue_label")
          .select(["issue_id", "label"])
          .where(ofVisibleIssue),
    }),
    child({
      name: "issue_components",
      description: "Components, one row per ticket and component",
      columns: [
        col("issue_id", "text", "Ticket id"),
        col("component_id", "text", "Component id"),
        col("component", "text", "Component name"),
      ],
      reads: [{ table: "track_issue_component" }, { table: "track_component" }],
      build: async () =>
        db
          .selectFrom("track_issue_component as ic")
          .innerJoin("track_component as c", "c.id", "ic.component_id")
          .select(["ic.issue_id", "ic.component_id", "c.name as component"])
          .where(sql<SqlBool>`ic.issue_id in (select id from issues)`),
    }),
    child({
      name: "issue_versions",
      description: "Versions, one row per ticket, version and kind",
      columns: [
        col("issue_id", "text", "Ticket id"),
        col("version_id", "text", "Version id"),
        col("version", "text", "Version name"),
        col("kind", "text", "fix or affects"),
        col("release_date", "date", "Planned or actual release"),
        col("released", "boolean", "True when released"),
      ],
      reads: [{ table: "track_issue_version" }, { table: "track_version" }],
      build: async () =>
        db
          .selectFrom("track_issue_version as iv")
          .innerJoin("track_version as v", "v.id", "iv.version_id")
          .select([
            "iv.issue_id",
            "iv.version_id",
            "v.name as version",
            "iv.kind",
            "v.release_date",
            "v.released",
          ])
          .where(sql<SqlBool>`iv.issue_id in (select id from issues)`),
    }),
    child({
      name: "issue_field_values",
      description:
        "Custom field values row by row, for fields with several values",
      columns: [
        col("issue_id", "text", "Ticket id"),
        col("field", "text", "Field key"),
        col("position", "number", "Order of the value"),
        col("value_text", "text", "Text value"),
        col("value_number", "number", "Number value"),
        col("value_date", "datetime", "Date value"),
        col("value_ref", "text", "Id of the option, user, group or ticket"),
      ],
      reads: [
        { table: "track_issue_field_value" },
        { table: "track_field", columns: ["id", "key"] },
      ],
      build: async () =>
        db
          .selectFrom("track_issue_field_value as fv")
          .innerJoin("track_field as f", "f.id", "fv.field_id")
          .select([
            "fv.issue_id",
            "f.key as field",
            "fv.position",
            "fv.value_text",
            "fv.value_number",
            "fv.value_date",
            "fv.value_ref",
          ])
          .where(sql<SqlBool>`fv.issue_id in (select id from issues)`),
    }),
    {
      name: "versions",
      description: "Versions of the projects you may browse",
      needs: ["projects"],
      columns: [
        col("id", "text", "Version id"),
        col("project_id", "text", "Project id"),
        col("name", "text", "Name"),
        col("start_date", "date", "Start"),
        col("release_date", "date", "Planned or actual release"),
        col("released", "boolean", "True once released"),
      ],
      reads: [{ table: "track_version" }],
      async build() {
        return db
          .selectFrom("track_version")
          .select([
            "id",
            "project_id",
            "name",
            "start_date",
            "release_date",
            "released",
          ])
          .where(sql<SqlBool>`project_id in (select id from projects)`);
      },
    },
    {
      name: "components",
      description: "Components of the projects you may browse",
      needs: ["projects"],
      columns: [
        col("id", "text", "Component id"),
        col("project_id", "text", "Project id"),
        col("name", "text", "Name"),
        col("lead_id", "text", "User id of the lead"),
      ],
      reads: [{ table: "track_component" }],
      async build() {
        return db
          .selectFrom("track_component")
          .select(["id", "project_id", "name", "lead_id"])
          .where(sql<SqlBool>`project_id in (select id from projects)`);
      },
    },
    {
      name: "sprints",
      description:
        "Sprints of the boards you may open (whose query is shared with you)",
      columns: [
        col("id", "text", "Sprint id"),
        col("board_id", "text", "Board id"),
        col("board", "text", "Board name"),
        col("project_id", "text", "Project of the board, if any"),
        col("name", "text", "Name"),
        col("goal", "text", "Goal"),
        col("state", "text", "future, active or closed"),
        col("start_at", "datetime", "Start"),
        col("end_at", "datetime", "End"),
      ],
      reads: [
        { table: "track_sprint" },
        {
          table: "track_board",
          columns: ["id", "name", "query_id", "project_id"],
        },
        {
          table: "core_saved_query",
          columns: ["id", "owner_id", "visibility", "group_id"],
        },
      ],
      async build({ user }) {
        const q = db
          .selectFrom("track_sprint as s")
          .innerJoin("track_board as b", "b.id", "s.board_id")
          .select([
            "s.id",
            "s.board_id",
            "b.name as board",
            "b.project_id",
            "s.name",
            "s.goal",
            "s.state",
            "s.start_at",
            "s.end_at",
          ]);
        // Boards are for staff; a board shows to whoever may see its query.
        if (!user || user.kind === "customer") return q.where(never);
        const groups = await ctx.permissions.groupIds(user.id);
        const core = db as unknown as Kysely<CoreDb>;
        return q.where(
          "b.query_id",
          "in",
          core
            .selectFrom("core_saved_query")
            .select("id")
            .where((eb) =>
              eb.or([
                eb("visibility", "=", "global"),
                eb("owner_id", "=", user.id),
                ...(groups.length
                  ? [
                      eb.and([
                        eb("visibility", "=", "group"),
                        eb("group_id", "in", groups),
                      ]),
                    ]
                  : []),
              ]),
            ),
        );
      },
    },
  ];
  for (const table of tables) app.query.register(table);
}
