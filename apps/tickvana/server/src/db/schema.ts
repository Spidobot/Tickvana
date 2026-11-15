// Row types of the track_* tables. Keep in step with ./migrations.
// DATE columns are "YYYY-MM-DD" strings, `*_json` columns hold JSON text.
import type { CoreDb } from "@tvn/core";

export type StatusCategory = "todo" | "in_progress" | "done";
export type GranteeType =
  | "role"
  | "group"
  | "user"
  | "anyone"
  | "logged_in"
  | "reporter"
  | "assignee"
  | "customer";
export type LayoutOperation =
  "create" | "edit" | "view" | "transition" | "portal";

export interface TrackTables {
  track_issue_type: { id: string; name: string; icon: string; level: number };
  track_status: { id: string; name: string; category: StatusCategory };
  track_priority: { id: string; name: string; position: number; color: string };
  track_resolution: { id: string; name: string };
  track_link_type: {
    id: string;
    name: string;
    outward: string;
    inward: string;
  };
  track_project_role: { id: string; name: string };

  track_workflow: { id: string; name: string };
  track_workflow_status: {
    workflow_id: string;
    status_id: string;
    x: number;
    y: number;
  };
  track_workflow_transition: {
    id: string;
    workflow_id: string;
    from_status_id: string | null;
    to_status_id: string;
    name: string;
    field_layout_id: string | null;
    rules_json: string;
  };

  track_field: {
    id: string;
    key: string;
    name: string;
    type: string;
    is_system: boolean;
    config_json: string;
  };
  track_field_option: {
    id: string;
    field_id: string;
    parent_id: string | null;
    value: string;
    position: number;
    disabled: boolean;
  };
  track_field_layout: { id: string; name: string };
  track_field_layout_item: {
    layout_id: string;
    operation: LayoutOperation;
    field_id: string;
    position: number;
    tab: string;
    required: boolean;
    hidden: boolean;
  };

  track_permission_scheme: { id: string; name: string };
  track_permission_grant: {
    id: string;
    scheme_id: string;
    permission: string;
    grantee_type: GranteeType;
    grantee_id: string | null;
  };
  track_notification_scheme: { id: string; name: string };
  track_notification_rule: {
    id: string;
    scheme_id: string;
    event_type: string;
    recipient_type: string;
    recipient_id: string | null;
  };

  track_project: {
    id: string;
    key: string;
    name: string;
    kind: "software" | "service" | "business";
    lead_id: string;
    permission_scheme_id: string;
    notification_scheme_id: string;
    issue_counter: number;
    archived: boolean;
    created_at: Date;
  };
  track_project_issue_type: {
    project_id: string;
    issue_type_id: string;
    workflow_id: string;
    field_layout_id: string;
  };
  track_project_role_member: {
    project_id: string;
    role_id: string;
    principal_type: "user" | "group";
    principal_id: string;
  };
  track_security_level: { id: string; project_id: string; name: string };
  track_security_level_member: {
    id: string;
    level_id: string;
    grantee_type: GranteeType;
    grantee_id: string | null;
  };
  track_component: {
    id: string;
    project_id: string;
    name: string;
    lead_id: string | null;
  };
  track_version: {
    id: string;
    project_id: string;
    name: string;
    start_date: string | null;
    release_date: string | null;
    released: boolean;
  };

  track_issue: {
    id: string;
    project_id: string;
    number: number;
    key: string;
    type_id: string;
    status_id: string;
    summary: string;
    description_json: string | null;
    description_text: string;
    priority_id: string;
    resolution_id: string | null;
    reporter_id: string;
    assignee_id: string | null;
    parent_id: string | null;
    security_level_id: string | null;
    rank: string;
    due_date: string | null;
    estimate_sec: number | null;
    remaining_sec: number | null;
    spent_sec: number;
    created_at: Date;
    updated_at: Date;
    resolved_at: Date | null;
    request_type_id: string | null;
  };
  track_issue_field_value: {
    issue_id: string;
    field_id: string;
    position: number;
    value_text: string | null;
    value_number: number | null;
    value_date: Date | null;
    value_ref: string | null;
  };
  track_issue_change: {
    id: string;
    issue_id: string;
    actor_id: string;
    created_at: Date;
  };
  track_issue_change_item: {
    id: string;
    change_id: string;
    field_key: string;
    from_value: string | null;
    from_text: string | null;
    to_value: string | null;
    to_text: string | null;
  };
  track_comment: {
    id: string;
    issue_id: string;
    author_id: string;
    body_json: string;
    body_text: string;
    visibility: "public" | "internal";
    created_at: Date;
    updated_at: Date;
  };
  track_worklog: {
    id: string;
    issue_id: string;
    author_id: string;
    started_at: Date;
    seconds: number;
    note: string;
    created_at: Date;
  };
  track_watcher: { issue_id: string; user_id: string };
  track_vote: { issue_id: string; user_id: string };
  track_issue_label: { issue_id: string; label: string };
  track_issue_component: { issue_id: string; component_id: string };
  track_issue_version: {
    issue_id: string;
    version_id: string;
    kind: "fix" | "affects";
  };
  track_issue_link: {
    id: string;
    type_id: string;
    from_issue_id: string;
    to_issue_id: string;
  };

  track_board: {
    id: string;
    name: string;
    kind: "scrum" | "kanban";
    query_id: string;
    columns_json: string;
    swimlane_json: string;
    estimate_field_id: string | null;
    project_id: string | null;
  };
  track_sprint: {
    id: string;
    board_id: string;
    name: string;
    goal: string;
    start_at: Date | null;
    end_at: Date | null;
    state: "future" | "active" | "closed";
  };
  track_sprint_issue: {
    sprint_id: string;
    issue_id: string;
    added_at: Date;
    removed_at: Date | null;
  };

  track_automation_rule: {
    id: string;
    project_id: string | null;
    name: string;
    trigger_json: string;
    conditions_json: string;
    actions_json: string;
    actor_id: string;
    enabled: boolean;
  };
  track_bulk_operation: {
    id: string;
    actor_id: string;
    action_json: string;
    pending_json: string;
    total: number;
    done: number;
    errors_json: string;
    state: "running" | "finished";
    created_at: Date;
    finished_at: Date | null;
  };
  track_automation_caused: { event_id: string; run_id: string };
  track_request_type: {
    id: string;
    project_id: string;
    issue_type_id: string;
    name: string;
    description: string;
    icon: string;
    group_name: string;
    field_layout_id: string;
    defaults_json: string;
    position: number;
  };
  track_organization: { id: string; name: string };
  track_organization_member: { organization_id: string; user_id: string };
  track_project_customer: {
    project_id: string;
    principal_type: "user" | "organization";
    principal_id: string;
  };
  track_queue: {
    id: string;
    project_id: string;
    name: string;
    query_id: string;
    position: number;
  };
  track_calendar: {
    id: string;
    name: string;
    timezone: string;
    hours_json: string;
    holidays_json: string;
  };
  track_sla_policy: {
    id: string;
    project_id: string;
    name: string;
    calendar_id: string;
    start_json: string;
    pause_json: string;
    stop_json: string;
    goals_json: string;
  };
  track_sla_cycle: {
    id: string;
    issue_id: string;
    policy_id: string;
    started_at: Date;
    /** bigint: PostgreSQL returns it as a string. */
    paused_ms: number | string;
    paused_at: Date | null;
    due_at: Date;
    stopped_at: Date | null;
    breached: boolean;
  };
  track_approval: {
    id: string;
    issue_id: string;
    approver_id: string;
    decision: "approved" | "declined" | null;
    decided_at: Date | null;
  };
  track_canned_response: {
    id: string;
    project_id: string | null;
    name: string;
    body_json: string;
  };
  track_mail_channel: {
    id: string;
    project_id: string;
    request_type_id: string;
    imap_json: string;
    active: boolean;
  };
  track_workflow_draft: {
    workflow_id: string;
    definition_json: string;
    updated_by: string;
    updated_at: Date;
  };
  track_automation_run: {
    id: string;
    rule_id: string;
    event_id: string | null;
    state: string;
    log_json: string;
    created_at: Date;
  };
}

export type TrackDb = CoreDb & TrackTables;
