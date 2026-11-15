import { requireUser, SYSTEM_ADMIN } from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { TrackContext } from "../context.js";
import { rulesSchema, type WorkflowService } from "../workflow.js";

const keyParam = z.object({ key: z.string().max(30) });
const idParam = z.object({ id: z.string() });
const category = z.enum(["todo", "in_progress", "done"]);

export async function workflowRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
  workflows: WorkflowService,
): Promise<void> {
  const r = scope.withTypeProvider<ZodTypeProvider>();
  // The service checks per ticket.
  const custom = { permission: "custom" as const };
  const staff = { permission: "authenticated" as const };

  r.get(
    "/issues/:key/transitions",
    {
      config: custom,
      schema: {
        params: keyParam,
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              toStatusId: z.string(),
              fieldLayoutId: z.string().nullable(),
            }),
          ),
        },
      },
    },
    (req) => workflows.available(req.user, req.params.key),
  );

  r.post(
    "/issues/:key/transitions",
    {
      config: custom,
      schema: {
        params: keyParam,
        body: z.object({
          transitionId: z.string(),
          /** Values entered on the transition screen, by field key. */
          fields: z.record(z.string(), z.unknown()).default({}),
        }),
      },
    },
    (req) =>
      workflows.transition(
        requireUser(req),
        req.params.key,
        req.body.transitionId,
        req.body.fields,
      ),
  );

  r.get(
    "/statuses",
    {
      config: staff,
      schema: {
        response: {
          200: z.array(
            z.object({ id: z.string(), name: z.string(), category }),
          ),
        },
      },
    },
    () =>
      ctx.db.selectFrom("track_status").selectAll().orderBy("name").execute(),
  );

  r.get(
    "/workflows",
    {
      config: staff,
      schema: {
        response: {
          200: z.array(z.object({ id: z.string(), name: z.string() })),
        },
      },
    },
    () =>
      ctx.db.selectFrom("track_workflow").selectAll().orderBy("name").execute(),
  );

  const transition = z.object({
    name: z.string().trim().min(1).max(100),
    /** null: available from every status */
    fromStatusId: z.string().nullable(),
    toStatusId: z.string(),
    fieldLayoutId: z.string().nullable().default(null),
    rules: rulesSchema.default({
      conditions: [],
      validators: [],
      postFunctions: [],
    }),
  });

  r.get(
    "/workflows/:id",
    {
      config: staff,
      schema: {
        params: idParam,
        response: {
          200: z.object({
            id: z.string(),
            name: z.string(),
            statuses: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                category,
                x: z.number(),
                y: z.number(),
              }),
            ),
            transitions: z.array(transition.extend({ id: z.string() })),
            /** Statuses nothing leads to, and open statuses nothing leads out of. */
            problems: z.array(
              z.object({
                statusId: z.string(),
                problem: z.enum(["unreachable", "dead_end"]),
              }),
            ),
          }),
        },
      },
    },
    (req) => workflows.describe(req.params.id),
  );

  r.post(
    "/workflows/:id/transitions",
    {
      config: { permission: SYSTEM_ADMIN },
      schema: {
        params: idParam,
        body: transition,
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    async (req, reply) => {
      await workflows.describe(req.params.id);
      return reply
        .status(201)
        .send({ id: await workflows.addTransition(req.params.id, req.body) });
    },
  );
}
