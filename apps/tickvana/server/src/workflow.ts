// The workflow engine: which transitions a ticket offers, who may run them,
// what must be true first, and what happens afterwards. Rules are entries of
// the registries below with parameters. There are no user scripts (CONCEPT.md §4).
import { AppError, uuidv7, type AuthUser } from "@tvn/core";
import type { Kysely } from "kysely";
import { z } from "zod";
import { issueTarget } from "./access.js";
import type { TrackContext } from "./context.js";
import { PROJECT_PERMISSIONS } from "./db/migrations/0002_seed.js";
import type { TrackDb } from "./db/schema.js";
import {
  assertRequired,
  isEmpty,
  normalizeCustomValues,
  resolveLayout,
  writeCustomValues,
} from "./fields.js";
import type { Issue, IssueService } from "./issues.js";

type Db = Kysely<TrackDb>;
type IssueRow = TrackDb["track_issue"];
type Values = Record<string, unknown>;

/** A rule as stored in rules_json: the name of a registry entry plus its parameters. */
const rule = z.looseObject({ fn: z.string() });
export const rulesSchema = z.object({
  conditions: z.array(rule).default([]),
  validators: z.array(rule).default([]),
  postFunctions: z.array(rule).default([]),
});
export type Rules = z.infer<typeof rulesSchema>;
type Rule = z.infer<typeof rule>;

interface RunContext {
  db: Db;
  ctx: TrackContext;
  actor: AuthUser;
  issue: IssueRow;
  /** Field values the ticket will have after the transition, by key. */
  values: Values;
}

const param = (r: Rule, name: string): string => {
  const v = r[name];
  if (typeof v !== "string" || !v)
    throw new Error(`Workflow rule "${r.fn}" needs parameter "${name}"`);
  return v;
};

/** Who may run the transition. All conditions of a transition must hold. */
export const CONDITIONS: Record<
  string,
  (r: Rule, c: RunContext) => Promise<boolean> | boolean
> = {
  isAssignee: (_r, c) => c.issue.assignee_id === c.actor.id,
  isReporter: (_r, c) => c.issue.reporter_id === c.actor.id,
  /** { groupId } */
  inGroup: async (r, c) =>
    (await c.ctx.permissions.groupIds(c.actor.id)).includes(
      param(r, "groupId"),
    ),
  /** { roleId }: project role, held directly or through a group */
  inRole: async (r, c) => {
    const groups = await c.ctx.permissions.groupIds(c.actor.id);
    const member = await c.db
      .selectFrom("track_project_role_member")
      .select("role_id")
      .where("project_id", "=", c.issue.project_id)
      .where("role_id", "=", param(r, "roleId"))
      .where((eb) =>
        eb.or([
          eb.and([
            eb("principal_type", "=", "user"),
            eb("principal_id", "=", c.actor.id),
          ]),
          ...(groups.length
            ? [
                eb.and([
                  eb("principal_type", "=", "group"),
                  eb("principal_id", "in", groups),
                ]),
              ]
            : []),
        ]),
      )
      .executeTakeFirst();
    return member !== undefined;
  },
  /** { permission }: a project permission, e.g. "project.administer" */
  hasPermission: (r, c) => {
    const permission = param(
      r,
      "permission",
    ) as (typeof PROJECT_PERMISSIONS)[number];
    if (!PROJECT_PERMISSIONS.includes(permission))
      throw new Error(`Unknown permission "${permission}" in workflow rule`);
    return c.ctx.access.can(c.actor, permission, issueTarget(c.issue));
  },
};

/** What must be true before the transition. Return a message to refuse, or nothing. */
export const VALIDATORS: Record<
  string,
  (r: Rule, c: RunContext) => Promise<string | void> | string | void
> = {
  /** { field }: field key that must have a value */
  fieldRequired: (r, c) =>
    isEmpty(c.values[param(r, "field")])
      ? `${param(r, "field")} must be filled in`
      : undefined,
  /** The latest approval round is complete and nobody declined. */
  approved: async (_r, c) => {
    const rows = await c.db
      .selectFrom("track_approval")
      .select(["decision", "decided_at"])
      .where("issue_id", "=", c.issue.id)
      .orderBy("id", "desc")
      .execute();
    if (!rows.length) return "Approval has not been requested";
    if (rows.some((a) => a.decision === "declined"))
      return "Approval was declined";
    if (rows.some((a) => a.decision === null)) return "Waiting for approval";
    return undefined;
  },
  /** Every ticket hanging under this one must be done. */
  subtasksDone: async (_r, c) => {
    const open = await c.db
      .selectFrom("track_issue as i")
      .innerJoin("track_status as s", "s.id", "i.status_id")
      .select("i.key")
      .where("i.parent_id", "=", c.issue.id)
      .where("s.category", "!=", "done")
      .orderBy("i.number")
      .execute();
    return open.length
      ? `Still open underneath: ${open.map((o) => o.key).join(", ")}`
      : undefined;
  },
};

/** Field changes a post function asks for. Applied in the transition's transaction. */
interface Effect {
  /** Field values by key, validated like an edit. */
  set?: Values;
  resolutionId?: string | null;
  /** Extra event to emit, besides issue.transitioned. */
  event?: string;
  /** Key of a person field: everyone in it is asked for approval (a new round). */
  approvalField?: string;
}

/** What happens after the status changed. */
export const POST_FUNCTIONS: Record<
  string,
  (r: Rule, c: RunContext) => Effect
> = {
  /** { resolutionId } */
  setResolution: (r) => ({ resolutionId: param(r, "resolutionId") }),
  clearResolution: () => ({ resolutionId: null }),
  assignToActor: (_r, c) => ({ set: { assignee: c.actor.id } }),
  assignToReporter: (_r, c) => ({ set: { assignee: c.issue.reporter_id } }),
  clearAssignee: () => ({ set: { assignee: null } }),
  /** { field, value }: sets any writable field */
  setField: (r) => ({ set: { [param(r, "field")]: r.value ?? null } }),
  /** { type }: emits an event for automations and webhooks */
  emit: (r) => ({ event: param(r, "type") }),
  /** { field }: asks the people in this field to approve; see the validator "approved". */
  requestApproval: (r) => ({ approvalField: param(r, "field") }),
};

/** Checks that every rule names a registry entry. Call before storing a workflow. */
export function assertKnownRules(rules: Rules): void {
  for (const [list, registry] of [
    [rules.conditions, CONDITIONS],
    [rules.validators, VALIDATORS],
    [rules.postFunctions, POST_FUNCTIONS],
  ] as const) {
    for (const r of list)
      if (!Object.hasOwn(registry, r.fn))
        throw new AppError(
          400,
          "validation",
          `Unknown workflow rule "${r.fn}"`,
        );
  }
}

export interface WorkflowProblem {
  statusId: string;
  problem: "unreachable" | "dead_end";
}

/**
 * Finds statuses a ticket could never reach from the initial status, and
 * statuses that are not "done" but have no way out.
 */
export async function validateWorkflow(
  db: Db,
  workflowId: string,
): Promise<WorkflowProblem[]> {
  const statuses = await db
    .selectFrom("track_workflow_status as ws")
    .innerJoin("track_status as s", "s.id", "ws.status_id")
    .select(["s.id", "s.category", "ws.x"])
    .where("ws.workflow_id", "=", workflowId)
    .orderBy("ws.x")
    .execute();
  const transitions = await db
    .selectFrom("track_workflow_transition")
    .select(["from_status_id", "to_status_id"])
    .where("workflow_id", "=", workflowId)
    .execute();
  return findProblems(statuses, transitions);
}

/** The same check on a workflow that is not stored yet. Statuses ordered left to right. */
export function findProblems(
  statuses: { id: string; category: string }[],
  transitions: { from_status_id: string | null; to_status_id: string }[],
): WorkflowProblem[] {
  const initial = statuses.find((s) => s.category === "todo") ?? statuses[0];
  if (!initial) return [];

  const ids = new Set(statuses.map((s) => s.id));
  const next = (from: string) =>
    transitions
      .filter(
        (t) =>
          (t.from_status_id === null || t.from_status_id === from) &&
          t.to_status_id !== from &&
          ids.has(t.to_status_id),
      )
      .map((t) => t.to_status_id);
  const reached = new Set([initial.id]);
  for (const queue = [initial.id]; queue.length;) {
    for (const to of next(queue.shift()!)) {
      if (!reached.has(to)) {
        reached.add(to);
        queue.push(to);
      }
    }
  }
  return statuses.flatMap((s): WorkflowProblem[] => [
    ...(reached.has(s.id)
      ? []
      : [{ statusId: s.id, problem: "unreachable" as const }]),
    ...(s.category !== "done" && next(s.id).length === 0
      ? [{ statusId: s.id, problem: "dead_end" as const }]
      : []),
  ]);
}

export interface AvailableTransition {
  id: string;
  name: string;
  toStatusId: string;
  /** Layout whose "transition" fields the client should ask for, if any. */
  fieldLayoutId: string | null;
}

export function createWorkflowService(ctx: TrackContext, issues: IssueService) {
  const { db, access } = ctx;
  const {
    allFields,
    mapping,
    normalizeSystem,
    writeLinks,
    present,
    recordChanges,
  } = issues.internals;

  /** Transitions of the ticket's workflow that leave its current status. */
  async function candidates(issue: IssueRow) {
    const map = await mapping(db, issue.project_id, issue.type_id);
    const rows = await db
      .selectFrom("track_workflow_transition")
      .selectAll()
      .where("workflow_id", "=", map.workflow_id)
      .orderBy("name")
      .execute();
    return rows.filter(
      (t) =>
        (t.from_status_id === null || t.from_status_id === issue.status_id) &&
        t.to_status_id !== issue.status_id,
    );
  }

  const passes = async (rules: Rules, c: RunContext) => {
    for (const r of rules.conditions) {
      const check = CONDITIONS[r.fn];
      if (!check) throw new Error(`Unknown workflow condition "${r.fn}"`);
      if (!(await check(r, c))) return false;
    }
    return true;
  };

  return {
    /** What the user can do with the ticket right now. */
    async available(
      user: AuthUser | null,
      key: string,
    ): Promise<AvailableTransition[]> {
      const issue = await issues.load(user, key);
      if (
        !user ||
        !(await access.can(user, "issue.transition", issueTarget(issue)))
      )
        return [];
      const out: AvailableTransition[] = [];
      for (const t of await candidates(issue)) {
        const rules = rulesSchema.parse(JSON.parse(t.rules_json));
        if (await passes(rules, { db, ctx, actor: user, issue, values: {} })) {
          out.push({
            id: t.id,
            name: t.name,
            toStatusId: t.to_status_id,
            fieldLayoutId: t.field_layout_id,
          });
        }
      }
      return out;
    },

    /** Runs a transition. `input` are field values entered on the transition screen. */
    async transition(
      actor: AuthUser,
      key: string,
      transitionId: string,
      input: Values = {},
    ): Promise<Issue> {
      const issue = await issues.load(actor, key, "issue.transition");
      const t = (await candidates(issue)).find((c) => c.id === transitionId);
      if (!t)
        throw new AppError(
          409,
          "conflict",
          "This transition is not available in the ticket's current status",
        );
      for (const readOnly of ["status", "type", "resolution"]) {
        if (Object.hasOwn(input, readOnly))
          throw new AppError(
            400,
            "validation",
            `${readOnly} cannot be set on a transition screen`,
          );
      }

      const rules = rulesSchema.parse(JSON.parse(t.rules_json));
      const fields = await allFields();
      const old = (await present(db, [issue]))[0]!;
      const run: RunContext = {
        db,
        ctx,
        actor,
        issue,
        values: { ...old.fields, ...input },
      };
      if (!(await passes(rules, run)))
        throw new AppError(
          403,
          "forbidden",
          "You do not have permission to do this",
        );

      const project = { id: issue.project_id };
      const system = await normalizeSystem(
        db,
        project,
        issue.type_id,
        issue.id,
        input,
      );
      const custom = await normalizeCustomValues(db, fields, input);
      if (t.field_layout_id)
        assertRequired(
          await resolveLayout(db, t.field_layout_id, "transition"),
          run.values,
        );
      const refusals: string[] = [];
      for (const r of rules.validators) {
        const check = VALIDATORS[r.fn];
        if (!check) throw new Error(`Unknown workflow validator "${r.fn}"`);
        const message = await check(r, run);
        if (message) refusals.push(message);
      }
      if (refusals.length)
        throw new AppError(
          400,
          "validation",
          refusals.join(". "),
          refusals.map((message) => ({ message })),
        );

      // Post functions say what else changes. Later ones win over earlier ones.
      const effect: Effect & { set: Values; events: string[] } = {
        set: {},
        events: [],
      };
      for (const r of rules.postFunctions) {
        const fn = POST_FUNCTIONS[r.fn];
        if (!fn) throw new Error(`Unknown workflow post function "${r.fn}"`);
        const e = fn(r, run);
        Object.assign(effect.set, e.set);
        if (e.resolutionId !== undefined) effect.resolutionId = e.resolutionId;
        if (e.event) effect.events.push(e.event);
        if (e.approvalField) effect.approvalField = e.approvalField;
      }
      const postSystem = await normalizeSystem(
        db,
        project,
        issue.type_id,
        issue.id,
        effect.set,
      );
      const postCustom = await normalizeCustomValues(db, fields, effect.set);
      if (effect.resolutionId) {
        const known = await db
          .selectFrom("track_resolution")
          .select("id")
          .where("id", "=", effect.resolutionId)
          .executeTakeFirst();
        if (!known)
          throw new Error(
            `Workflow transition "${t.name}" sets a resolution that does not exist`,
          );
      }

      const target = await db
        .selectFrom("track_status")
        .select("category")
        .where("id", "=", t.to_status_id)
        .executeTakeFirstOrThrow();
      const now = new Date();
      await db.transaction().execute(async (trx) => {
        // Re-check under the row lock: two people may click at the same time.
        const moved = await trx
          .updateTable("track_issue")
          .set({
            ...system.columns,
            ...postSystem.columns,
            status_id: t.to_status_id,
            ...(effect.resolutionId !== undefined && {
              resolution_id: effect.resolutionId,
            }),
            resolved_at:
              target.category === "done" ? (issue.resolved_at ?? now) : null,
            updated_at: now,
          })
          .where("id", "=", issue.id)
          .where("status_id", "=", issue.status_id)
          .executeTakeFirst();
        if (moved.numUpdatedRows !== 1n)
          throw new AppError(
            409,
            "conflict",
            "The ticket changed in the meantime. Reload and try again",
          );

        await writeLinks(trx, issue.id, system);
        await writeLinks(trx, issue.id, postSystem);
        await writeCustomValues(
          trx,
          issue.id,
          new Map([...custom, ...postCustom]),
        );

        const row = await trx
          .selectFrom("track_issue")
          .selectAll()
          .where("id", "=", issue.id)
          .executeTakeFirstOrThrow();
        const after = (await present(trx, [row]))[0]!;
        const touched = [
          "status",
          "resolution",
          ...Object.keys(input),
          ...Object.keys(effect.set),
        ];
        await recordChanges(
          trx,
          issue.id,
          actor.id,
          fields,
          old.fields,
          Object.fromEntries(touched.map((k) => [k, after.fields[k]])),
          now,
        );

        const payload = {
          key: issue.key,
          from: issue.status_id,
          to: t.to_status_id,
          transition: t.name,
        };
        await ctx.emit(trx, {
          type: "issue.transitioned",
          actorId: actor.id,
          entityType: "issue",
          entityId: issue.id,
          payload,
        });
        for (const type of effect.events)
          await ctx.emit(trx, {
            type,
            actorId: actor.id,
            entityType: "issue",
            entityId: issue.id,
            payload,
          });
        if (effect.approvalField) {
          const who = [
            run.values[effect.approvalField],
            effect.set[effect.approvalField],
          ]
            .flat()
            .filter((v): v is string => typeof v === "string");
          // A new round replaces the earlier one; its decisions stay in the history as events.
          await trx
            .deleteFrom("track_approval")
            .where("issue_id", "=", issue.id)
            .execute();
          const ids: string[] = [];
          for (const approverId of new Set(who)) {
            const id = uuidv7();
            ids.push(id);
            await trx
              .insertInto("track_approval")
              .values({
                id,
                issue_id: issue.id,
                approver_id: approverId,
                decision: null,
                decided_at: null,
              })
              .execute();
          }
          if (ids.length)
            await ctx.emit(trx, {
              type: "approval.requested",
              actorId: actor.id,
              entityType: "issue",
              entityId: issue.id,
              payload: { key: issue.key, approvalIds: ids },
            });
        }
      });
      return issues.get(actor, issue.key);
    },

    /** A workflow with its statuses, transitions and structural problems. */
    async describe(workflowId: string) {
      const workflow = await db
        .selectFrom("track_workflow")
        .selectAll()
        .where("id", "=", workflowId)
        .executeTakeFirst();
      if (!workflow) throw new AppError(404, "not_found", "Not found");
      const [statuses, transitions, problems] = await Promise.all([
        db
          .selectFrom("track_workflow_status as ws")
          .innerJoin("track_status as s", "s.id", "ws.status_id")
          .select(["s.id", "s.name", "s.category", "ws.x", "ws.y"])
          .where("ws.workflow_id", "=", workflowId)
          .orderBy("ws.x")
          .execute(),
        db
          .selectFrom("track_workflow_transition")
          .selectAll()
          .where("workflow_id", "=", workflowId)
          .orderBy("name")
          .execute(),
        validateWorkflow(db, workflowId),
      ]);
      return {
        id: workflow.id,
        name: workflow.name,
        statuses,
        transitions: transitions.map((t) => ({
          id: t.id,
          name: t.name,
          fromStatusId: t.from_status_id,
          toStatusId: t.to_status_id,
          fieldLayoutId: t.field_layout_id,
          rules: rulesSchema.parse(JSON.parse(t.rules_json)),
        })),
        problems,
      };
    },

    /** Adds a transition to a workflow. The graphical editor (A-1) builds on this. */
    async addTransition(
      workflowId: string,
      t: {
        name: string;
        fromStatusId: string | null;
        toStatusId: string;
        fieldLayoutId?: string | null;
        rules?: unknown;
      },
    ) {
      const rules = rulesSchema.parse(t.rules ?? {});
      assertKnownRules(rules);
      const inWorkflow = new Set(
        (
          await db
            .selectFrom("track_workflow_status")
            .select("status_id")
            .where("workflow_id", "=", workflowId)
            .execute()
        ).map((s) => s.status_id),
      );
      if (
        !inWorkflow.has(t.toStatusId) ||
        (t.fromStatusId !== null && !inWorkflow.has(t.fromStatusId))
      ) {
        throw new AppError(
          400,
          "validation",
          "Both ends of a transition must be statuses of the workflow",
        );
      }
      const id = uuidv7();
      await db
        .insertInto("track_workflow_transition")
        .values({
          id,
          workflow_id: workflowId,
          from_status_id: t.fromStatusId,
          to_status_id: t.toStatusId,
          name: t.name,
          field_layout_id: t.fieldLayoutId ?? null,
          rules_json: JSON.stringify(rules),
        })
        .execute();
      return id;
    },
  };
}

export type WorkflowService = ReturnType<typeof createWorkflowService>;
