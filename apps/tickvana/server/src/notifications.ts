// Who hears about what happens to a ticket, and how it reads. Recipients come
// from the project's notification scheme; nobody is told about a ticket or an
// internal comment they may not see.
import type { AppContext, AuthUser, CoreDb, StoredEvent } from "@tvn/core";
import type { Kysely } from "kysely";
import { issueTarget } from "./access.js";
import type { TrackContext } from "./context.js";

/** Events that notify. Anything else about a ticket is silent. */
const NOTIFYING = [
  "issue.created",
  "issue.updated",
  "issue.assigned",
  "issue.transitioned",
  "issue.commented",
];

const TEXT = {
  de: {
    someone: "Jemand",
    created: (who: string) => `${who} hat das Ticket angelegt`,
    updated: (who: string, fields: string) => `${who} hat geändert: ${fields}`,
    assigned: (who: string, to: string) =>
      to ? `${who} hat ${to} zugewiesen` : `${who} hat die Zuweisung entfernt`,
    transitioned: (who: string, from: string, to: string) =>
      `${who}: ${from} → ${to}`,
    commented: (who: string) => `${who} hat kommentiert`,
  },
  en: {
    someone: "Someone",
    created: (who: string) => `${who} created the ticket`,
    updated: (who: string, fields: string) => `${who} changed: ${fields}`,
    assigned: (who: string, to: string) =>
      to ? `${who} assigned ${to}` : `${who} removed the assignee`,
    transitioned: (who: string, from: string, to: string) =>
      `${who}: ${from} → ${to}`,
    commented: (who: string) => `${who} commented`,
  },
};

export function installTrackNotifications(
  ctx: TrackContext,
  app: AppContext,
): void {
  const { db, access } = ctx;
  const core = db as unknown as Kysely<CoreDb>;

  const toAuthUser = (u: CoreDb["core_user"]): AuthUser => ({
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    kind: u.kind,
    locale: u.locale,
    timezone: u.timezone,
  });

  /** Internal comments are only for people who hold comment.internal. */
  async function maySee(
    user: AuthUser,
    issue: Parameters<typeof issueTarget>[0],
    event: StoredEvent,
  ): Promise<boolean> {
    if (!(await access.can(user, "project.browse", issueTarget(issue))))
      return false;
    const internal =
      event.type === "issue.commented" &&
      (event.payload as { visibility?: string } | null)?.visibility ===
        "internal";
    return (
      !internal || access.can(user, "comment.internal", issueTarget(issue))
    );
  }

  app.queue.on("track-notify", ["issue.*"], async (event) => {
    if (!NOTIFYING.includes(event.type)) return;
    const issue = await db
      .selectFrom("track_issue")
      .selectAll()
      .where("id", "=", event.entityId)
      .executeTakeFirst();
    if (!issue) return;
    const project = await db
      .selectFrom("track_project")
      .select(["notification_scheme_id", "lead_id"])
      .where("id", "=", issue.project_id)
      .executeTakeFirstOrThrow();
    const rules = await db
      .selectFrom("track_notification_rule")
      .select(["recipient_type", "recipient_id"])
      .where("scheme_id", "=", project.notification_scheme_id)
      .where("event_type", "=", event.type)
      .execute();

    const candidates = new Set<string>();
    const addGroup = async (groupId: string) => {
      for (const m of await db
        .selectFrom("core_group_member")
        .select("user_id")
        .where("group_id", "=", groupId)
        .execute())
        candidates.add(m.user_id);
    };
    for (const rule of rules) {
      switch (rule.recipient_type) {
        case "assignee":
          if (issue.assignee_id) candidates.add(issue.assignee_id);
          break;
        case "reporter":
          candidates.add(issue.reporter_id);
          break;
        case "project_lead":
          candidates.add(project.lead_id);
          break;
        case "watchers":
          for (const w of await db
            .selectFrom("track_watcher")
            .select("user_id")
            .where("issue_id", "=", issue.id)
            .execute())
            candidates.add(w.user_id);
          break;
        case "user":
          if (rule.recipient_id) candidates.add(rule.recipient_id);
          break;
        case "group":
          if (rule.recipient_id) await addGroup(rule.recipient_id);
          break;
        case "role":
          for (const m of await db
            .selectFrom("track_project_role_member")
            .selectAll()
            .where("project_id", "=", issue.project_id)
            .where("role_id", "=", rule.recipient_id ?? "")
            .execute()) {
            if (m.principal_type === "user") candidates.add(m.principal_id);
            else await addGroup(m.principal_id);
          }
          break;
      }
    }
    // Nobody needs to hear about their own action.
    if (event.actorId) candidates.delete(event.actorId);
    if (candidates.size === 0) return;

    const users = await db
      .selectFrom("core_user")
      .selectAll()
      .where("id", "in", [...candidates])
      .where("active", "=", true)
      .execute();
    const recipients: string[] = [];
    for (const u of users)
      if (await maySee(toAuthUser(u), issue, event)) recipients.push(u.id);
    await app.notifier.notify(core, recipients, event.id);
  });

  app.notifier.describe("issue.", async (event, reader) => {
    const issue = await db
      .selectFrom("track_issue")
      .selectAll()
      .where("id", "=", event.entityId)
      .executeTakeFirst();
    // Deleted, or access was taken away since: the notification disappears.
    if (!issue || !(await maySee(reader, issue, event))) return null;

    const t = reader.locale.startsWith("de") ? TEXT.de : TEXT.en;
    const name = async (id: string | null | undefined) =>
      id
        ? ((
            await db
              .selectFrom("core_user")
              .select("display_name")
              .where("id", "=", id)
              .executeTakeFirst()
          )?.display_name ?? "")
        : "";
    const who = (await name(event.actorId)) || t.someone;
    const payload = (event.payload ?? {}) as {
      fields?: string[];
      from?: string;
      to?: string;
    };

    let text: string;
    if (event.type === "issue.created") text = t.created(who);
    else if (event.type === "issue.commented") text = t.commented(who);
    else if (event.type === "issue.assigned")
      text = t.assigned(who, await name(issue.assignee_id));
    else if (event.type === "issue.transitioned") {
      const statuses = await db
        .selectFrom("track_status")
        .select(["id", "name"])
        .where("id", "in", [payload.from ?? "", payload.to ?? ""])
        .execute();
      const label = (id?: string) =>
        statuses.find((s) => s.id === id)?.name ?? "";
      text = t.transitioned(who, label(payload.from), label(payload.to));
    } else {
      const fields = await db
        .selectFrom("track_field")
        .select(["key", "name"])
        .where("key", "in", payload.fields?.length ? payload.fields : [""])
        .execute();
      // In the order they were changed, whatever order the database returns.
      const names = (payload.fields ?? []).map(
        (key) => fields.find((f) => f.key === key)?.name ?? key,
      );
      text = t.updated(who, names.join(", "));
    }
    return {
      title: `${issue.key} ${issue.summary}`,
      text,
      url: `/tickvana/issues/${issue.key}`,
    };
  });
}
