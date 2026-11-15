// Row types of the core_* tables. Keep in step with src/migrations.
// `*_json` columns hold JSON text: parse and validate with Zod where they are read.

export interface CoreDb {
  core_user: {
    id: string;
    email: string;
    display_name: string;
    password_hash: string | null;
    kind: "internal" | "customer" | "service";
    active: boolean;
    locale: string;
    timezone: string;
    created_at: Date;
    updated_at: Date;
  };
  core_identity: {
    provider: string;
    subject: string;
    user_id: string;
    created_at: Date;
  };
  core_group: { id: string; name: string; created_at: Date };
  core_group_member: { group_id: string; user_id: string };
  core_session: {
    id_hash: string;
    user_id: string;
    expires_at: Date;
    created_at: Date;
  };
  core_api_token: {
    id: string;
    token_hash: string;
    user_id: string;
    name: string;
    expires_at: Date | null;
    last_used_at: Date | null;
    created_at: Date;
  };
  core_setting: { key: string; value_json: string; updated_at: Date };
  core_attachment: {
    id: string;
    owner_type: string;
    owner_id: string;
    filename: string;
    mime: string;
    size: number;
    storage_key: string;
    created_by: string;
    created_at: Date;
  };
  core_event: {
    id: string;
    type: string;
    actor_id: string | null;
    entity_type: string;
    entity_id: string;
    payload_json: string;
    created_at: Date;
  };
  core_job: {
    id: string;
    type: string;
    payload_json: string;
    run_at: Date;
    state: "pending" | "running" | "done" | "failed";
    attempts: number;
    locked_by: string | null;
    locked_at: Date | null;
    last_error: string | null;
    created_at: Date;
  };
  core_notification: {
    id: string;
    user_id: string;
    event_id: string;
    read_at: Date | null;
    mailed_at: Date | null;
    created_at: Date;
  };
  core_webhook: {
    id: string;
    url: string;
    secret: string;
    event_filter_json: string;
    active: boolean;
    created_at: Date;
    name: string | null;
  };
  core_webhook_delivery: {
    id: string;
    webhook_id: string;
    event_id: string;
    event_type: string;
    attempt: number;
    status_code: number | null;
    error: string | null;
    duration_ms: number;
    created_at: Date;
  };
  core_saved_query: {
    id: string;
    owner_id: string;
    name: string;
    sql: string;
    params_json: string;
    visibility: "private" | "group" | "global";
    group_id: string | null;
    created_at: Date;
    updated_at: Date;
  };
  core_dashboard: {
    id: string;
    owner_id: string;
    name: string;
    visibility: "private" | "group" | "global";
    group_id: string | null;
    layout_json: string;
    created_at: Date;
    updated_at: Date;
  };
  core_home_dashboard: {
    user_id: string;
    dashboard_id: string;
  };
  core_dashboard_widget: {
    id: string;
    dashboard_id: string;
    query_id: string;
    kind: string;
    config_json: string;
  };
  core_global_grant: {
    id: string;
    permission: string;
    grantee_type: "user" | "group" | "logged_in" | "anyone";
    grantee_id: string | null;
    created_at: Date;
  };
  core_query_subscription: {
    id: string;
    query_id: string;
    user_id: string;
    weekdays: string;
    hour: number;
    last_sent_on: string | null;
  };
  core_link: {
    from_type: string;
    from_id: string;
    to_type: string;
    to_id: string;
    kind: string;
    created_at: Date;
  };
}
