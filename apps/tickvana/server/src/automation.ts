// Automation rules: when something happens (an event, a schedule, a click),
// check conditions on the ticket and run actions. Actions go through the
// normal services as the rule's author, so a rule can never do more than
// the person who wrote it. Events a rule causes start no further rules,
// so rules cannot loop.
import {
  AppError,
  requireUser,
  SYSTEM_ADMIN,
  uuidv7,
  type AppContext,
  type AuthUser,
  type CoreDb,
  type StoredEvent,
} from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { TrackContext } from "./context.js";
import type { TrackDb } from "./db/schema.js";
import type { Issue, IssueService } from "./issues.js";
import { addComment } from "./routes/issue-parts.js";
import type { WorkflowService } from "./workflow.js";

export const triggerSchema = z.discriminatedUnion("kind", [
  /** Event types like issue.created or issue.* */
  z.object({
    kind: z.literal("event"),
    types: z.array(z.string().regex(/^issue\.([a-z_]+|\*)$/)).min(1),
  }),
  /** Runs for every ticket a saved query returns. */
  z.object({
    kind: z.literal("schedule"),
    everyMinutes: z.number().int().min(5).max(10_080),
    queryId: z.string(),
  }),
  z.object({ kind: z.literal("manual") }),
]);

export const conditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("field"),
    field: z.string().max(60),
    op: z.enum(["=", "!=", "empty", "not_empty", "contains"]),
    value: z.unknown().optional(),
  }),
  /** The ticket is in the result of a saved query, run as the author. */
  z.object({ kind: z.literal("query"), queryId: z.string() }),
]);

export const actionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("setFields"),
    fields: z.record(z.string(), z.unknown()),
  }),
  z.object({ kind: z.literal("transition"), toStatusId: z.string() }),
  z.object({
    kind: z.literal("comment"),
    text: z.string().min(1).max(10_000),
    visibility: z.enum(["public", "internal"]).default("internal"),
  }),
  /** A user id, "reporter", "author" (of the rule) or null to unassign. */
  z.object({ kind: z.literal("assign"), to: z.string().nullable() }),
  z.object({
    kind: z.literal("createIssue"),
    projectKey: z.string().max(10),
    typeId: z.string(),
    fields: z.record(z.string(), z.unknown()),
  }),
  /** {{key}} and {{summary}} are replaced in subject and body. */
  z.object({
    kind: z.literal("mail"),
    to: z.enum(["assignee", "reporter", "watchers"]),
    subject: z.string().min(1).max(200),
    body: z.string().max(5000),
  }),
  /** Emits automation.<event>; webhooks subscribed to it receive it. */
  z.object({
    kind: z.literal("webhook"),
    event: z.string().regex(/^[a-z_]{1,40}$/),
  }),
]);

type Trigger = z.infer<typeof triggerSchema>;
type Condition = z.infer<typeof conditionSchema>;
type Action = z.infer<typeof actionSchema>;
type Rule = TrackDb["track_automation_rule"];

export interface RunResult {
  runId: string;
  state: "success" | "skipped" | "failed";
  log: string[];
}

const matches = (pattern: string, type: string) =>
  pattern === type ||
  (pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1)));
const fill = (template: string, issue: Issue) =>
  template
    .replaceAll("{{key}}", issue.key)
    .replaceAll("{{summary}}", String(issue.fields.summary ?? ""));
const triggerOf = (rule: Rule): Trigger =>
  triggerSchema.parse(JSON.parse(rule.trigger_json));

export function createAutomation(
  ctx: TrackContext,
  app: AppContext,
  issues: IssueService,
  workflows: WorkflowService,
) {
  const { db } = ctx;

  async function author(rule: Rule): Promise<AuthUser | null> {
    const u = await db
      .selectFrom("core_user")
      .selectAll()
      .where("id", "=", rule.actor_id)
      .where("active", "=", true)
      .executeTakeFirst();
    return u
      ? {
          id: u.id,
          email: u.email,
          displayName: u.display_name,
          kind: u.kind,
          locale: u.locale,
          timezone: u.timezone,
        }
      : null;
  }

  function fieldMatches(
    c: Extract<Condition, { kind: "field" }>,
    issue: Issue,
  ) {
    const value = issue.fields[c.field];
    const empty =
      value === null ||
      value === undefined ||
      value === "" ||
      (Array.isArray(value) && value.length === 0);
    switch (c.op) {
      case "empty":
        return empty;
      case "not_empty":
        return !empty;
      case "=":
        return JSON.stringify(value) === JSON.stringify(c.value);
      case "!=":
        return JSON.stringify(value) !== JSON.stringify(c.value);
      case "contains":
        return Array.isArray(value)
          ? value.includes(c.value)
          : String(value ?? "")
              .toLowerCase()
              .includes(String(c.value ?? "").toLowerCase());
    }
  }

  async function act(a: Action, actor: AuthUser, issue: Issue, log: string[]) {
    switch (a.kind) {
      case "setFields":
        await issues.update(actor, issue.key, a.fields);
        log.push(`Set ${Object.keys(a.fields).join(", ")}`);
        return;
      case "assign": {
        const to =
          a.to === "reporter"
            ? ((issue.fields.reporter as string | null) ?? null)
            : a.to === "author"
              ? actor.id
              : a.to;
        await issues.update(actor, issue.key, { assignee: to });
        log.push(`Assigned to ${to ?? "nobody"}`);
        return;
      }
      case "transition": {
        const t = (await workflows.available(actor, issue.key)).find(
          (x) => x.toStatusId === a.toStatusId,
        );
        if (!t)
          throw new AppError(409, "conflict", "No transition to this status");
        await workflows.transition(actor, issue.key, t.id);
        log.push(`Transition ${t.name}`);
        return;
      }
      case "comment": {
        const doc = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: fill(a.text, issue) }],
            },
          ],
        };
        await addComment(ctx, issues, actor, issue.key, doc, a.visibility);
        log.push("Commented");
        return;
      }
      case "createIssue": {
        const made = await issues.create(
          actor,
          a.projectKey,
          a.typeId,
          a.fields,
        );
        log.push(`Created ${made.key}`);
        return;
      }
      case "mail": {
        const ids =
          a.to === "watchers"
            ? (
                await db
                  .selectFrom("track_watcher")
                  .select("user_id")
                  .where("issue_id", "=", issue.id)
                  .execute()
              ).map((w) => w.user_id)
            : [issue.fields[a.to] as string | null].filter(
                (x): x is string => !!x,
              );
        const users = ids.length
          ? await db
              .selectFrom("core_user")
              .select("email")
              .where("id", "in", ids)
              .where("active", "=", true)
              .execute()
          : [];
        for (const u of users)
          await app.mailer.send(db as unknown as Kysely<CoreDb>, {
            to: u.email,
            subject: fill(a.subject, issue),
            body: fill(a.body, issue).split(/\n{2,}/),
          });
        log.push(`Mailed ${users.length}`);
        return;
      }
      case "webhook":
        await ctx.emit(db, {
          type: `automation.${a.event}`,
          actorId: actor.id,
          entityType: "issue",
          entityId: issue.id,
          payload: { key: issue.key, fields: issue.fields },
        });
        log.push(`Sent automation.${a.event}`);
        return;
    }
  }

  /** Runs one rule for one ticket and logs the run. A dry run checks the conditions, changes nothing and logs nothing. */
  async function run(
    rule: Rule,
    issueKey: string,
    eventId: string | null,
    dryRun = false,
  ): Promise<RunResult> {
    // UUIDv7 grows with time: every event created after this id is newer.
    const runId = uuidv7();
    const created = new Date();
    const log: string[] = [];
    let state: RunResult["state"] = "success";
    const actor = await author(rule);
    try {
      if (!actor) throw new Error("The rule's author is no longer active");
      // As the author: a ticket they cannot see is skipped.
      const issue = await issues.get(actor, issueKey).catch(() => null);
      if (!issue) {
        state = "skipped";
        log.push("The author may not see this ticket");
      } else {
        for (const c of z
          .array(conditionSchema)
          .parse(JSON.parse(rule.conditions_json))) {
          const ok =
            c.kind === "field"
              ? fieldMatches(c, issue)
              : (
                  await app.savedQueries.run(actor, c.queryId, {
                    limit: 10_000,
                  })
                ).rows.some((r) => r.id === issue.id || r.key === issue.key);
          if (!ok) {
            state = "skipped";
            log.push(
              c.kind === "field"
                ? `Condition not met: ${c.field} ${c.op}`
                : "Condition not met: ticket not in query",
            );
            break;
          }
        }
        if (state === "success")
          for (const a of z
            .array(actionSchema)
            .parse(JSON.parse(rule.actions_json)))
            if (dryRun) log.push(`Would run ${a.kind}`);
            else await act(a, actor, issue, log);
      }
    } catch (e) {
      state = "failed";
      log.push(e instanceof Error ? e.message : String(e));
    }
    if (dryRun) return { runId, state, log };

    await db
      .insertInto("track_automation_run")
      .values({
        id: runId,
        rule_id: rule.id,
        event_id: eventId,
        state,
        log_json: JSON.stringify(log),
        created_at: created,
      })
      .execute();
    if (actor) {
      // ponytail: events by the author during the run count as caused by it,
      // even one the author clicked at that very moment. That event then
      // starts no rules; acceptable.
      const caused = await db
        .selectFrom("core_event")
        .select("id")
        .where("actor_id", "=", actor.id)
        .where("id", ">", runId)
        .execute();
      if (caused.length)
        await db
          .insertInto("track_automation_caused")
          .values(caused.map((e) => ({ event_id: e.id, run_id: runId })))
          .execute();
    }
    return { runId, state, log };
  }

  async function onEvent(event: StoredEvent): Promise<void> {
    if (event.entityType !== "issue") return;
    const caused = await db
      .selectFrom("track_automation_caused")
      .select("event_id")
      .where("event_id", "=", event.id)
      .executeTakeFirst();
    if (caused) return;
    const issue = await db
      .selectFrom("track_issue")
      .select(["key", "project_id"])
      .where("id", "=", event.entityId)
      .executeTakeFirst();
    if (!issue) return;
    const rules = await db
      .selectFrom("track_automation_rule")
      .selectAll()
      .where("enabled", "=", true)
      .where((eb) =>
        eb.or([
          eb("project_id", "=", issue.project_id),
          eb("project_id", "is", null),
        ]),
      )
      .orderBy("id")
      .execute();
    for (const rule of rules) {
      const t = triggerOf(rule);
      if (t.kind === "event" && t.types.some((p) => matches(p, event.type)))
        await run(rule, issue.key, event.id);
    }
  }

  /** Scheduled rules whose interval has passed run for each ticket of their query. */
  async function runSchedules(now = new Date()): Promise<number> {
    let count = 0;
    const rules = await db
      .selectFrom("track_automation_rule")
      .selectAll()
      .where("enabled", "=", true)
      .orderBy("id")
      .execute();
    for (const rule of rules) {
      const t = triggerOf(rule);
      if (t.kind !== "schedule") continue;
      const last = await db
        .selectFrom("track_automation_run")
        .select("created_at")
        .where("rule_id", "=", rule.id)
        .orderBy("created_at", "desc")
        .executeTakeFirst();
      if (
        last &&
        now.getTime() - last.created_at.getTime() < t.everyMinutes * 60_000
      )
        continue;
      const actor = await author(rule);
      // ponytail: at most 100 tickets a round; the next round takes the rest.
      const result = actor
        ? await app.savedQueries
            .run(actor, t.queryId, { limit: 100 })
            .catch(() => null)
        : null;
      const ids = (result?.rows ?? [])
        .map((r) => r.id)
        .filter((x): x is string => typeof x === "string");
      const keys = ids.length
        ? await db
            .selectFrom("track_issue")
            .select("key")
            .where("id", "in", ids)
            .orderBy("key")
            .execute()
        : [];
      if (keys.length === 0)
        // Logged so the interval counts from now.
        await db
          .insertInto("track_automation_run")
          .values({
            id: uuidv7(),
            rule_id: rule.id,
            event_id: null,
            state: "skipped",
            log_json: JSON.stringify([
              result ? "No tickets" : "The query could not run",
            ]),
            created_at: now,
          })
          .execute();
      for (const { key } of keys) {
        await run(rule, key, null);
        count++;
      }
    }
    return count;
  }

  app.queue.on("track-automation", ["issue.*"], onEvent);
  app.queue.every("track-automation-schedule", 60_000, async () => {
    await runSchedules();
  });

  return { run, runSchedules };
}

export type Automation = ReturnType<typeof createAutomation>;

// --- Routes ---------------------------------------------------------------------------

const ruleBody = z.object({
  name: z.string().min(1).max(200),
  trigger: triggerSchema,
  conditions: z.array(conditionSchema).max(20).default([]),
  actions: z.array(actionSchema).min(1).max(20),
  enabled: z.boolean().default(true),
});
const ruleOut = ruleBody.extend({
  id: z.string(),
  projectKey: z.string().nullable(),
  authorId: z.string(),
});
const runOut = z.object({
  id: z.string(),
  eventId: z.string().nullable(),
  state: z.string(),
  log: z.array(z.string()),
  createdAt: z.string(),
});
const idParam = z.object({ id: z.string() });

export async function automationRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
  app: AppContext,
  issues: IssueService,
  automation: Automation,
): Promise<void> {
  const { db } = ctx;
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const custom = { permission: "custom" as const };

  /** Project rules need project administration, global rules the system administrator. */
  async function manage(user: AuthUser, projectKey: string | null) {
    if (projectKey === null) {
      await app.permissions.require(user, SYSTEM_ADMIN);
      return null;
    }
    return (await ctx.project(user, projectKey, "project.administer")).id;
  }
  const withProject = () =>
    db
      .selectFrom("track_automation_rule as r")
      .leftJoin("track_project as p", "p.id", "r.project_id")
      .selectAll("r")
      .select("p.key as project_key");
  async function loadRule(user: AuthUser, id: string) {
    const rule = await withProject().where("r.id", "=", id).executeTakeFirst();
    if (!rule) throw new AppError(404, "not_found", "Not found");
    await manage(user, rule.project_key);
    return rule;
  }
  const present = (rule: Rule & { project_key: string | null }) => ({
    id: rule.id,
    projectKey: rule.project_key,
    authorId: rule.actor_id,
    name: rule.name,
    trigger: triggerOf(rule),
    conditions: z
      .array(conditionSchema)
      .parse(JSON.parse(rule.conditions_json)),
    actions: z.array(actionSchema).parse(JSON.parse(rule.actions_json)),
    enabled: Boolean(rule.enabled),
  });
  const columns = (body: z.infer<typeof ruleBody>, user: AuthUser) => ({
    name: body.name,
    trigger_json: JSON.stringify(body.trigger),
    conditions_json: JSON.stringify(body.conditions),
    actions_json: JSON.stringify(body.actions),
    // A rule runs with the rights of whoever saved it last.
    actor_id: user.id,
    enabled: body.enabled,
  });

  r.get(
    "/automations",
    {
      config: custom,
      schema: {
        querystring: z.object({ project: z.string().max(10).optional() }),
        response: { 200: z.array(ruleOut) },
      },
    },
    async (req) => {
      const projectId = await manage(
        requireUser(req),
        req.query.project ?? null,
      );
      const query = withProject();
      const rows = await (
        projectId
          ? query.where("r.project_id", "=", projectId)
          : query.where("r.project_id", "is", null)
      )
        .orderBy("r.name")
        .execute();
      return rows.map(present);
    },
  );

  r.post(
    "/automations",
    {
      config: custom,
      schema: {
        body: ruleBody.extend({ projectKey: z.string().max(10).nullable() }),
        response: { 201: ruleOut },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const rule: Rule = {
        id: uuidv7(),
        project_id: await manage(user, req.body.projectKey),
        ...columns(req.body, user),
      };
      await db.insertInto("track_automation_rule").values(rule).execute();
      return reply
        .status(201)
        .send(present({ ...rule, project_key: req.body.projectKey }));
    },
  );

  r.put(
    "/automations/:id",
    {
      config: custom,
      schema: { params: idParam, body: ruleBody, response: { 200: ruleOut } },
    },
    async (req) => {
      const user = requireUser(req);
      const rule = await loadRule(user, req.params.id);
      const next = columns(req.body, user);
      await db
        .updateTable("track_automation_rule")
        .set(next)
        .where("id", "=", rule.id)
        .execute();
      return present({ ...rule, ...next });
    },
  );

  r.delete(
    "/automations/:id",
    { config: custom, schema: { params: idParam } },
    async (req, reply) => {
      const rule = await loadRule(requireUser(req), req.params.id);
      await db
        .deleteFrom("track_automation_rule")
        .where("id", "=", rule.id)
        .execute();
      return reply.status(204).send(null);
    },
  );

  r.get(
    "/automations/:id/runs",
    {
      config: custom,
      schema: { params: idParam, response: { 200: z.array(runOut) } },
    },
    async (req) => {
      const rule = await loadRule(requireUser(req), req.params.id);
      const runs = await db
        .selectFrom("track_automation_run")
        .selectAll()
        .where("rule_id", "=", rule.id)
        .orderBy("id", "desc")
        .limit(100)
        .execute();
      return runs.map((x) => ({
        id: x.id,
        eventId: x.event_id,
        state: x.state,
        log: JSON.parse(x.log_json) as string[],
        createdAt: x.created_at.toISOString(),
      }));
    },
  );

  /** Manual rules a ticket offers: for anyone who may edit it. */
  r.get(
    "/issues/:key/automations",
    {
      config: custom,
      schema: {
        params: z.object({ key: z.string().max(30) }),
        response: {
          200: z.array(z.object({ id: z.string(), name: z.string() })),
        },
      },
    },
    async (req) => {
      const issue = await issues.load(
        requireUser(req),
        req.params.key,
        "issue.edit",
      );
      const rules = await db
        .selectFrom("track_automation_rule")
        .selectAll()
        .where("enabled", "=", true)
        .where((eb) =>
          eb.or([
            eb("project_id", "=", issue.project_id),
            eb("project_id", "is", null),
          ]),
        )
        .orderBy("name")
        .execute();
      return rules
        .filter((x) => triggerOf(x).kind === "manual")
        .map((x) => ({ id: x.id, name: x.name }));
    },
  );

  r.post(
    "/issues/:key/automations/:id",
    {
      config: custom,
      schema: {
        params: z.object({ key: z.string().max(30), id: z.string() }),
        response: {
          200: z.object({
            runId: z.string(),
            state: z.string(),
            log: z.array(z.string()),
          }),
        },
      },
    },
    async (req) => {
      const issue = await issues.load(
        requireUser(req),
        req.params.key,
        "issue.edit",
      );
      const rule = await db
        .selectFrom("track_automation_rule")
        .selectAll()
        .where("id", "=", req.params.id)
        .where("enabled", "=", true)
        .executeTakeFirst();
      if (
        !rule ||
        triggerOf(rule).kind !== "manual" ||
        (rule.project_id !== null && rule.project_id !== issue.project_id)
      )
        throw new AppError(404, "not_found", "Not found");
      return automation.run(rule, issue.key, null);
    },
  );

  /** Dry run against one ticket, for the rule editor. */
  r.post(
    "/automations/:id/test",
    {
      config: custom,
      schema: {
        params: idParam,
        body: z.object({ issueKey: z.string().max(30) }),
        response: {
          200: z.object({ state: z.string(), log: z.array(z.string()) }),
        },
      },
    },
    async (req) => {
      const rule = await loadRule(requireUser(req), req.params.id);
      const { state, log } = await automation.run(
        rule,
        req.body.issueKey.toUpperCase(),
        null,
        true,
      );
      return { state, log };
    },
  );
}
