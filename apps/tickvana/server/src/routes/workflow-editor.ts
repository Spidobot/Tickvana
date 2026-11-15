// Editing workflows: create, a draft per workflow that the graphical editor
// saves as often as it likes, and publishing it. Publishing replaces the
// live statuses and transitions in one transaction. Tickets whose status the
// draft drops move to the status the administrator picked for it.
import { AppError, requireUser, SYSTEM_ADMIN, uuidv7 } from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { TrackContext } from "../context.js";
import {
  assertKnownRules,
  CONDITIONS,
  findProblems,
  POST_FUNCTIONS,
  rulesSchema,
  VALIDATORS,
  type WorkflowService,
} from "../workflow.js";

/** Parameters each rule takes, for the editor's forms. */
export const RULE_PARAMS: Record<string, string[]> = {
  isAssignee: [],
  isReporter: [],
  inGroup: ["groupId"],
  inRole: ["roleId"],
  hasPermission: ["permission"],
  fieldRequired: ["field"],
  subtasksDone: [],
  setResolution: ["resolutionId"],
  clearResolution: [],
  assignToActor: [],
  assignToReporter: [],
  clearAssignee: [],
  setField: ["field", "value"],
  emit: ["type"],
  requestApproval: ["field"],
  approved: [],
};

const draftSchema = z.object({
  name: z.string().trim().min(1).max(200),
  statuses: z
    .array(z.object({ statusId: z.string(), x: z.number(), y: z.number() }))
    .min(1)
    .max(100),
  transitions: z
    .array(
      z.object({
        /** Kept when the transition already exists, so links to it survive. */
        id: z.string().optional(),
        name: z.string().trim().min(1).max(100),
        fromStatusId: z.string().nullable(),
        toStatusId: z.string(),
        fieldLayoutId: z.string().nullable().default(null),
        rules: rulesSchema.default({
          conditions: [],
          validators: [],
          postFunctions: [],
        }),
      }),
    )
    .max(500),
});
type Draft = z.infer<typeof draftSchema>;

export async function workflowEditorRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
  workflows: WorkflowService,
): Promise<void> {
  const { db } = ctx;
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const config = { permission: SYSTEM_ADMIN };
  const idParam = z.object({ id: z.string() });

  /** The live workflow in the draft's shape. */
  async function current(id: string): Promise<Draft> {
    const w = await workflows.describe(id);
    return {
      name: w.name,
      statuses: w.statuses.map((s) => ({ statusId: s.id, x: s.x, y: s.y })),
      transitions: w.transitions,
    };
  }

  /** Statuses must exist, transitions must stay inside the draft, rules must be known. */
  async function check(d: Draft) {
    const known = await db.selectFrom("track_status").selectAll().execute();
    const ids = new Set(d.statuses.map((s) => s.statusId));
    if (ids.size !== d.statuses.length)
      throw new AppError(400, "validation", "A status appears twice");
    for (const id of ids)
      if (!known.some((s) => s.id === id))
        throw new AppError(400, "validation", `Unknown status ${id}`);
    for (const t of d.transitions) {
      if (
        !ids.has(t.toStatusId) ||
        (t.fromStatusId && !ids.has(t.fromStatusId))
      )
        throw new AppError(
          400,
          "validation",
          `Transition "${t.name}" must connect statuses of this workflow`,
        );
      assertKnownRules(t.rules);
    }
    const ordered = [...d.statuses]
      .sort((a, b) => a.x - b.x)
      .map((s) => ({
        id: s.statusId,
        category: known.find((k) => k.id === s.statusId)!.category,
      }));
    return findProblems(
      ordered,
      d.transitions.map((t) => ({
        from_status_id: t.fromStatusId,
        to_status_id: t.toStatusId,
      })),
    );
  }

  /** Tickets using this workflow, counted by status. */
  async function ticketsByStatus(workflowId: string) {
    const rows = await db
      .selectFrom("track_issue as i")
      .innerJoin("track_project_issue_type as m", (j) =>
        j
          .onRef("m.project_id", "=", "i.project_id")
          .onRef("m.issue_type_id", "=", "i.type_id"),
      )
      .select(["i.status_id", (eb) => eb.fn.countAll<number>().as("n")])
      .where("m.workflow_id", "=", workflowId)
      .groupBy("i.status_id")
      .execute();
    return new Map(rows.map((x) => [x.status_id, Number(x.n)]));
  }

  async function loadDraft(id: string) {
    const row = await db
      .selectFrom("track_workflow_draft")
      .selectAll()
      .where("workflow_id", "=", id)
      .executeTakeFirst();
    return row ? draftSchema.parse(JSON.parse(row.definition_json)) : null;
  }

  const draftOut = draftSchema.extend({
    /** false: nothing saved yet, this is the live workflow. */
    saved: z.boolean(),
    problems: z.array(
      z.object({
        statusId: z.string(),
        problem: z.enum(["unreachable", "dead_end"]),
      }),
    ),
    /** Statuses the draft drops that tickets still have. Publishing needs a target for each. */
    displaced: z.array(z.object({ statusId: z.string(), tickets: z.number() })),
  });
  async function present(id: string) {
    const saved = await loadDraft(id);
    const d = saved ?? (await current(id));
    const kept = new Set(d.statuses.map((s) => s.statusId));
    const counts = await ticketsByStatus(id);
    return {
      ...d,
      saved: saved !== null,
      problems: await check(d),
      displaced: [...counts]
        .filter(([statusId, n]) => n > 0 && !kept.has(statusId))
        .map(([statusId, tickets]) => ({ statusId, tickets })),
    };
  }

  r.get(
    "/workflow-rules",
    {
      config,
      schema: {
        response: {
          200: z.object({
            conditions: z.record(z.string(), z.array(z.string())),
            validators: z.record(z.string(), z.array(z.string())),
            postFunctions: z.record(z.string(), z.array(z.string())),
          }),
        },
      },
    },
    () => {
      const pick = (registry: object) =>
        Object.fromEntries(
          Object.keys(registry).map((fn) => [fn, RULE_PARAMS[fn] ?? []]),
        );
      return {
        conditions: pick(CONDITIONS),
        validators: pick(VALIDATORS),
        postFunctions: pick(POST_FUNCTIONS),
      };
    },
  );

  r.post(
    "/workflows",
    {
      config,
      schema: {
        body: z.object({
          name: z.string().trim().min(1).max(200),
          copyFrom: z.string().optional(),
        }),
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    async (req, reply) => {
      const id = uuidv7();
      const source = req.body.copyFrom
        ? await current(req.body.copyFrom)
        : null;
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto("track_workflow")
          .values({ id, name: req.body.name })
          .execute();
        if (source) {
          await trx
            .insertInto("track_workflow_status")
            .values(
              source.statuses.map((s) => ({
                workflow_id: id,
                status_id: s.statusId,
                x: s.x,
                y: s.y,
              })),
            )
            .execute();
          if (source.transitions.length)
            await trx
              .insertInto("track_workflow_transition")
              .values(
                source.transitions.map((t) => ({
                  id: uuidv7(),
                  workflow_id: id,
                  from_status_id: t.fromStatusId,
                  to_status_id: t.toStatusId,
                  name: t.name,
                  field_layout_id: t.fieldLayoutId,
                  rules_json: JSON.stringify(t.rules),
                })),
              )
              .execute();
        }
      });
      return reply.status(201).send({ id });
    },
  );

  r.delete(
    "/workflows/:id",
    { config, schema: { params: idParam } },
    async (req, reply) => {
      const { id } = req.params;
      const used =
        (await ctx.defaults()).workflowId === id ||
        !!(await db
          .selectFrom("track_project_issue_type")
          .select("workflow_id")
          .where("workflow_id", "=", id)
          .executeTakeFirst());
      if (used) throw new AppError(409, "conflict", "Still used by projects");
      await db.transaction().execute(async (trx) => {
        for (const table of [
          "track_workflow_transition",
          "track_workflow_status",
          "track_workflow_draft",
        ] as const)
          await trx.deleteFrom(table).where("workflow_id", "=", id).execute();
        await trx.deleteFrom("track_workflow").where("id", "=", id).execute();
      });
      return reply.status(204).send(null);
    },
  );

  r.get(
    "/workflows/:id/draft",
    { config, schema: { params: idParam, response: { 200: draftOut } } },
    (req) => present(req.params.id),
  );

  r.put(
    "/workflows/:id/draft",
    {
      config,
      schema: {
        params: idParam,
        body: draftSchema,
        response: { 200: draftOut },
      },
    },
    async (req) => {
      await workflows.describe(req.params.id);
      await check(req.body);
      const row = {
        workflow_id: req.params.id,
        definition_json: JSON.stringify(req.body),
        updated_by: requireUser(req).id,
        updated_at: new Date(),
      };
      await db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("track_workflow_draft")
          .where("workflow_id", "=", row.workflow_id)
          .execute();
        await trx.insertInto("track_workflow_draft").values(row).execute();
      });
      return present(req.params.id);
    },
  );

  r.delete(
    "/workflows/:id/draft",
    { config, schema: { params: idParam } },
    async (req, reply) => {
      await db
        .deleteFrom("track_workflow_draft")
        .where("workflow_id", "=", req.params.id)
        .execute();
      return reply.status(204).send(null);
    },
  );

  r.post(
    "/workflows/:id/publish",
    {
      config,
      schema: {
        params: idParam,
        body: z.object({
          /** Dropped status → status of the draft its tickets move to. */
          mapping: z.record(z.string(), z.string()).default({}),
        }),
        response: { 200: z.object({ moved: z.number() }) },
      },
    },
    async (req) => {
      const { id } = req.params;
      const draft = await loadDraft(id);
      if (!draft) throw new AppError(409, "conflict", "There is no draft");
      const view = await present(id);
      const kept = new Set(draft.statuses.map((s) => s.statusId));
      for (const d of view.displaced) {
        const target = req.body.mapping[d.statusId];
        if (!target || !kept.has(target))
          throw new AppError(
            400,
            "validation",
            "Choose a status of the draft for every status that still has tickets",
            [{ field: d.statusId, message: "needs a target status" }],
          );
      }
      const existing = new Set(
        (
          await db
            .selectFrom("track_workflow_transition")
            .select("id")
            .where("workflow_id", "=", id)
            .execute()
        ).map((t) => t.id),
      );
      let moved = 0;
      await db.transaction().execute(async (trx) => {
        for (const d of view.displaced) {
          // Tickets of every project and type that uses this workflow.
          const res = await trx
            .updateTable("track_issue")
            .set({
              status_id: req.body.mapping[d.statusId]!,
              updated_at: new Date(),
            })
            .where("status_id", "=", d.statusId)
            .where((eb) =>
              eb.exists(
                eb
                  .selectFrom("track_project_issue_type as m")
                  .select("m.workflow_id")
                  .whereRef("m.project_id", "=", "track_issue.project_id")
                  .whereRef("m.issue_type_id", "=", "track_issue.type_id")
                  .where("m.workflow_id", "=", id),
              ),
            )
            .executeTakeFirst();
          moved += Number(res.numUpdatedRows);
        }
        await trx
          .updateTable("track_workflow")
          .set({ name: draft.name })
          .where("id", "=", id)
          .execute();
        await trx
          .deleteFrom("track_workflow_transition")
          .where("workflow_id", "=", id)
          .execute();
        await trx
          .deleteFrom("track_workflow_status")
          .where("workflow_id", "=", id)
          .execute();
        await trx
          .insertInto("track_workflow_status")
          .values(
            draft.statuses.map((s) => ({
              workflow_id: id,
              status_id: s.statusId,
              x: s.x,
              y: s.y,
            })),
          )
          .execute();
        if (draft.transitions.length)
          await trx
            .insertInto("track_workflow_transition")
            .values(
              draft.transitions.map((t) => ({
                id: t.id && existing.has(t.id) ? t.id : uuidv7(),
                workflow_id: id,
                from_status_id: t.fromStatusId,
                to_status_id: t.toStatusId,
                name: t.name,
                field_layout_id: t.fieldLayoutId,
                rules_json: JSON.stringify(t.rules),
              })),
            )
            .execute();
        await trx
          .deleteFrom("track_workflow_draft")
          .where("workflow_id", "=", id)
          .execute();
        // ponytail: one event for the whole publish; moved tickets get no history entry each.
        await ctx.emit(trx, {
          type: "workflow.published",
          actorId: requireUser(req).id,
          entityType: "workflow",
          entityId: id,
          payload: { moved, mapping: req.body.mapping },
        });
      });
      return { moved };
    },
  );
}
