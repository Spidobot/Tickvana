import type {
  ColumnDefinitionBuilder,
  CreateTableBuilder,
  Kysely,
} from "kysely";
import type { Migration } from "kysely/migration";
import type { Dialect } from "@tvn/core";

/**
 * Column shorthand, so 40 tables stay readable:
 *   id            primary key (UUIDv7 text)
 *   ref:<table>   foreign key to <table>.id; add "!" to delete with the parent
 *   uid           foreign key to core_user.id
 *   s<n>          varchar(n)       text   unbounded text / JSON
 *   int  num  bool  ts  date
 * A trailing "?" makes the column nullable.
 */
type Spec = string;

/** All Track tables except the service desk. See CONCEPT.md §4. */
export function trackSchema({ types }: Dialect): Migration {
  function column(
    spec: Spec,
  ): [
    Parameters<CreateTableBuilder<string>["addColumn"]>[1],
    (c: ColumnDefinitionBuilder) => ColumnDefinitionBuilder,
  ] {
    const nullable = spec.includes("?");
    const cascade = spec.includes("!");
    const [kind, target] = spec.replace(/[?!]/g, "").split(":") as [
      string,
      string | undefined,
    ];
    const nn = (c: ColumnDefinitionBuilder) => (nullable ? c : c.notNull());
    const fk = (table: string) => (c: ColumnDefinitionBuilder) => {
      const ref = nn(c).references(`${table}.id`);
      return cascade ? ref.onDelete("cascade") : ref;
    };
    if (kind === "id") return [types.id, (c) => c.primaryKey()];
    if (kind === "ref") return [types.id, fk(target!)];
    if (kind === "uid") return [types.id, fk("core_user")];
    if (kind === "text") return [types.text, nn];
    if (kind === "ts") return [types.timestamp, nn];
    if (kind === "bool") return ["boolean", nn];
    if (kind === "int") return ["integer", nn];
    if (kind === "num") return ["double precision", nn];
    if (kind === "date") return ["date", nn];
    const length = /^s(\d+)$/.exec(kind)?.[1];
    if (length) return [`varchar(${length})` as "varchar(1)", nn];
    throw new Error(`Unknown column spec "${spec}"`);
  }

  return {
    async up(db: Kysely<never>) {
      const table = async (
        name: string,
        columns: Record<string, Spec>,
        opts: { pk?: string[]; unique?: string[][]; index?: string[][] } = {},
      ) => {
        let t = db.schema.createTable(name) as CreateTableBuilder<
          string,
          string
        >;
        for (const [col, spec] of Object.entries(columns))
          t = t.addColumn(col, ...column(spec));
        if (opts.pk)
          t = t.addPrimaryKeyConstraint(`pk_${name}`, opts.pk as never[]);
        for (const [i, cols] of (opts.unique ?? []).entries())
          t = t.addUniqueConstraint(`uq_${name}_${i}`, cols as never[]);
        await t.execute();
        for (const cols of opts.index ?? []) {
          await db.schema
            .createIndex(`idx_${name}_${cols.join("_")}`.slice(0, 60))
            .on(name)
            .columns(cols)
            .execute();
        }
      };

      // --- Configuration shared between projects --------------------------------
      await table("track_issue_type", {
        id: "id",
        name: "s100",
        icon: "s50",
        level: "int",
      }); // -1 sub-task, 0 standard, 1 epic
      await table("track_status", { id: "id", name: "s100", category: "s20" }); // todo | in_progress | done
      await table("track_priority", {
        id: "id",
        name: "s100",
        position: "int",
        color: "s20",
      });
      await table("track_resolution", { id: "id", name: "s100" });
      await table("track_link_type", {
        id: "id",
        name: "s100",
        outward: "s100",
        inward: "s100",
      });
      await table("track_project_role", { id: "id", name: "s100" });

      await table("track_workflow", { id: "id", name: "s200" });
      await table(
        "track_workflow_status",
        {
          workflow_id: "ref:track_workflow!",
          status_id: "ref:track_status",
          x: "int",
          y: "int",
        },
        { pk: ["workflow_id", "status_id"] },
      );

      await table(
        "track_field",
        {
          id: "id",
          key: "s60",
          name: "s200",
          type: "s30",
          is_system: "bool",
          config_json: "text",
        },
        { unique: [["key"]] },
      );
      await table(
        "track_field_option",
        {
          id: "id",
          field_id: "ref:track_field!",
          parent_id: "ref?:track_field_option",
          value: "s500",
          position: "int",
          disabled: "bool",
        },
        { index: [["field_id"]] },
      );
      await table("track_field_layout", { id: "id", name: "s200" });
      await table(
        "track_field_layout_item",
        {
          layout_id: "ref:track_field_layout!",
          operation: "s20", // create | edit | view | transition | portal
          field_id: "ref:track_field!",
          position: "int",
          tab: "s100",
          required: "bool",
          hidden: "bool",
        },
        { pk: ["layout_id", "operation", "field_id"] },
      );
      await table(
        "track_workflow_transition",
        {
          id: "id",
          workflow_id: "ref:track_workflow!",
          from_status_id: "ref?:track_status", // null: from any status
          to_status_id: "ref:track_status",
          name: "s100",
          field_layout_id: "ref?:track_field_layout",
          rules_json: "text",
        },
        { index: [["workflow_id"]] },
      );

      await table("track_permission_scheme", { id: "id", name: "s200" });
      await table(
        "track_permission_grant",
        {
          id: "id",
          scheme_id: "ref:track_permission_scheme!",
          permission: "s100",
          grantee_type: "s20",
          grantee_id: "s36?",
        },
        { index: [["scheme_id", "permission"]] },
      );
      await table("track_notification_scheme", { id: "id", name: "s200" });
      await table(
        "track_notification_rule",
        {
          id: "id",
          scheme_id: "ref:track_notification_scheme!",
          event_type: "s100",
          recipient_type: "s30",
          recipient_id: "s36?",
        },
        { index: [["scheme_id", "event_type"]] },
      );

      // --- Projects -----------------------------------------------------------------
      await table(
        "track_project",
        {
          id: "id",
          key: "s10",
          name: "s200",
          kind: "s20", // software | service | business
          lead_id: "uid",
          permission_scheme_id: "ref:track_permission_scheme",
          notification_scheme_id: "ref:track_notification_scheme",
          issue_counter: "int",
          archived: "bool",
          created_at: "ts",
        },
        { unique: [["key"]] },
      );
      await table(
        "track_project_issue_type",
        {
          project_id: "ref:track_project!",
          issue_type_id: "ref:track_issue_type",
          workflow_id: "ref:track_workflow",
          field_layout_id: "ref:track_field_layout",
        },
        { pk: ["project_id", "issue_type_id"] },
      );
      await table(
        "track_project_role_member",
        {
          project_id: "ref:track_project!",
          role_id: "ref:track_project_role",
          principal_type: "s20",
          principal_id: "s36",
        }, // user | group
        {
          pk: ["project_id", "role_id", "principal_type", "principal_id"],
          index: [["principal_type", "principal_id"]],
        },
      );
      await table(
        "track_security_level",
        { id: "id", project_id: "ref:track_project!", name: "s100" },
        { index: [["project_id"]] },
      );
      await table(
        "track_security_level_member",
        {
          id: "id",
          level_id: "ref:track_security_level!",
          grantee_type: "s20",
          grantee_id: "s36?",
        },
        { index: [["level_id"]] },
      );
      await table(
        "track_component",
        {
          id: "id",
          project_id: "ref:track_project!",
          name: "s200",
          lead_id: "uid?",
        },
        { index: [["project_id"]] },
      );
      await table(
        "track_version",
        {
          id: "id",
          project_id: "ref:track_project!",
          name: "s200",
          start_date: "date?",
          release_date: "date?",
          released: "bool",
        },
        { index: [["project_id"]] },
      );

      // --- Issues -----------------------------------------------------------------
      await table(
        "track_issue",
        {
          id: "id",
          project_id: "ref:track_project",
          number: "int",
          key: "s30", // "ABC-12", kept in step with project key and number
          type_id: "ref:track_issue_type",
          status_id: "ref:track_status",
          summary: "s500",
          description_json: "text?",
          description_text: "text",
          priority_id: "ref:track_priority",
          resolution_id: "ref?:track_resolution",
          reporter_id: "uid",
          assignee_id: "uid?",
          parent_id: "ref?:track_issue",
          security_level_id: "ref?:track_security_level",
          rank: "s200",
          due_date: "date?",
          estimate_sec: "int?",
          remaining_sec: "int?",
          spent_sec: "int",
          created_at: "ts",
          updated_at: "ts",
          resolved_at: "ts?",
        },
        {
          unique: [["key"], ["project_id", "number"]],
          index: [
            ["project_id", "rank"],
            ["status_id"],
            ["assignee_id"],
            ["reporter_id"],
            ["parent_id"],
            ["updated_at"],
          ],
        },
      );
      await table(
        "track_issue_field_value",
        {
          issue_id: "ref:track_issue!",
          field_id: "ref:track_field!",
          position: "int", // 0 for single values, 0..n for multi-value fields
          value_text: "text?",
          value_number: "num?",
          value_date: "ts?",
          value_ref: "s36?", // option, user, group or issue id
        },
        {
          pk: ["issue_id", "field_id", "position"],
          index: [
            ["field_id", "value_ref"],
            ["field_id", "value_number"],
            ["field_id", "value_date"],
          ],
        },
      );
      await table(
        "track_issue_change",
        {
          id: "id",
          issue_id: "ref:track_issue!",
          actor_id: "uid",
          created_at: "ts",
        },
        { index: [["issue_id"]] },
      );
      await table(
        "track_issue_change_item",
        {
          id: "id",
          change_id: "ref:track_issue_change!",
          field_key: "s60",
          from_value: "text?",
          from_text: "text?",
          to_value: "text?",
          to_text: "text?",
        },
        { index: [["change_id"]] },
      );
      await table(
        "track_comment",
        {
          id: "id",
          issue_id: "ref:track_issue!",
          author_id: "uid",
          body_json: "text",
          body_text: "text",
          visibility: "s20",
          created_at: "ts",
          updated_at: "ts",
        }, // public | internal
        { index: [["issue_id"]] },
      );
      await table(
        "track_worklog",
        {
          id: "id",
          issue_id: "ref:track_issue!",
          author_id: "uid",
          started_at: "ts",
          seconds: "int",
          note: "text",
          created_at: "ts",
        },
        { index: [["issue_id"], ["author_id", "started_at"]] },
      );
      await table(
        "track_watcher",
        { issue_id: "ref:track_issue!", user_id: "uid" },
        { pk: ["issue_id", "user_id"], index: [["user_id"]] },
      );
      await table(
        "track_vote",
        { issue_id: "ref:track_issue!", user_id: "uid" },
        { pk: ["issue_id", "user_id"] },
      );
      await table(
        "track_issue_label",
        { issue_id: "ref:track_issue!", label: "s100" },
        { pk: ["issue_id", "label"], index: [["label"]] },
      );
      await table(
        "track_issue_component",
        { issue_id: "ref:track_issue!", component_id: "ref:track_component!" },
        { pk: ["issue_id", "component_id"], index: [["component_id"]] },
      );
      await table(
        "track_issue_version",
        {
          issue_id: "ref:track_issue!",
          version_id: "ref:track_version!",
          kind: "s10",
        }, // fix | affects
        { pk: ["issue_id", "version_id", "kind"], index: [["version_id"]] },
      );
      await table(
        "track_issue_link",
        {
          id: "id",
          type_id: "ref:track_link_type",
          from_issue_id: "ref:track_issue!",
          to_issue_id: "ref:track_issue!",
        },
        {
          unique: [["type_id", "from_issue_id", "to_issue_id"]],
          index: [["from_issue_id"], ["to_issue_id"]],
        },
      );

      // --- Boards and sprints -----------------------------------------------------
      await table("track_board", {
        id: "id",
        name: "s200",
        kind: "s20", // scrum | kanban
        query_id: "ref:core_saved_query",
        columns_json: "text",
        swimlane_json: "text",
        estimate_field_id: "ref?:track_field",
      });
      await table(
        "track_sprint",
        {
          id: "id",
          board_id: "ref:track_board!",
          name: "s200",
          goal: "text",
          start_at: "ts?",
          end_at: "ts?",
          state: "s20",
        }, // future | active | closed
        { index: [["board_id"]] },
      );
      await table(
        "track_sprint_issue",
        {
          sprint_id: "ref:track_sprint!",
          issue_id: "ref:track_issue!",
          added_at: "ts",
          removed_at: "ts?",
        },
        { pk: ["sprint_id", "issue_id"], index: [["issue_id"]] },
      );

      // --- Automation -----------------------------------------------------------------
      await table(
        "track_automation_rule",
        {
          id: "id",
          project_id: "ref?:track_project!",
          name: "s200",
          trigger_json: "text",
          conditions_json: "text",
          actions_json: "text",
          actor_id: "uid",
          enabled: "bool",
        },
        { index: [["project_id"]] },
      );
      await table(
        "track_automation_run",
        {
          id: "id",
          rule_id: "ref:track_automation_rule!",
          event_id: "s36?",
          state: "s20",
          log_json: "text",
          created_at: "ts",
        },
        { index: [["rule_id"]] },
      );
    },
  };
}
