// Bulk changes: edit, transition or delete many tickets, picked by a query
// result or by keys. Runs as a background job in batches; every ticket goes
// through the normal service, so permissions, validation and history apply
// one by one, with the rights of the person who started it.
import {
  AppError,
  requireUser,
  uuidv7,
  type AuthUser,
  type CoreDb,
} from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { TrackContext } from "../context.js";
import type { TrackDb } from "../db/schema.js";
import type { IssueService } from "../issues.js";
import type { WorkflowService } from "../workflow.js";

const JOB = "track.bulk";
const BATCH = 25;
const MAX = 5000;

const action = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("edit"),
    fields: z.record(z.string(), z.unknown()),
  }),
  /** By target status, since every workflow has its own transition ids. */
  z.object({ kind: z.literal("transition"), toStatusId: z.string() }),
  z.object({ kind: z.literal("delete") }),
]);
/** Internal kinds started by other features, not through POST /bulk. */
const internal = z.discriminatedUnion("kind", [
  ...action.options,
  /** CSV import: each pending item is {label, type, fields} as JSON. */
  z.object({ kind: z.literal("create"), projectKey: z.string() }),
]);
type Action = z.infer<typeof internal>;
type Status = z.infer<typeof statusSchema>;

const statusSchema = z.object({
  id: z.string(),
  state: z.enum(["running", "finished"]),
  total: z.number(),
  done: z.number(),
  errors: z.array(z.object({ key: z.string(), message: z.string() })),
});

export function installBulk(
  scope: FastifyInstance,
  ctx: TrackContext,
  issues: IssueService,
  workflows: WorkflowService,
): void {
  const { db } = ctx;

  const toUser = (u: CoreDb["core_user"]): AuthUser => ({
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    kind: u.kind,
    locale: u.locale,
    timezone: u.timezone,
  });

  async function applyOne(
    actor: AuthUser,
    key: string,
    a: Action,
  ): Promise<void> {
    if (a.kind === "create") {
      const item = JSON.parse(key) as {
        type: string;
        fields: Record<string, unknown>;
      };
      await issues.create(actor, a.projectKey, item.type, item.fields);
    } else if (a.kind === "edit") await issues.update(actor, key, a.fields);
    else if (a.kind === "delete") await issues.remove(actor, key);
    else {
      const available = await workflows.available(actor, key);
      const transition = available.find((t) => t.toStatusId === a.toStatusId);
      if (!transition)
        throw new AppError(
          409,
          "conflict",
          "No transition to this status is available",
        );
      await workflows.transition(actor, key, transition.id, {});
    }
  }

  // One batch per job run, then the job queues the next one: a long operation
  // never holds a worker, and a restart continues where it stopped.
  ctx.queue.job(JOB, async (payload) => {
    const { id } = payload as { id: string };
    const op = await db
      .selectFrom("track_bulk_operation")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!op || op.state !== "running") return;
    const actorRow = await db
      .selectFrom("core_user")
      .selectAll()
      .where("id", "=", op.actor_id)
      .executeTakeFirstOrThrow();
    const pending = JSON.parse(op.pending_json) as string[];
    const batch = pending.slice(0, BATCH);
    const errors = JSON.parse(op.errors_json) as {
      key: string;
      message: string;
    }[];
    const a = internal.parse(JSON.parse(op.action_json));

    for (const key of batch) {
      try {
        // A deactivated author stops the rest.
        if (!actorRow.active)
          throw new AppError(
            403,
            "forbidden",
            "The account that started this was deactivated",
          );
        await applyOne(toUser(actorRow), key, a);
      } catch (e) {
        errors.push({
          key:
            a.kind === "create"
              ? (JSON.parse(key) as { label: string }).label
              : key,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    const rest = pending.slice(batch.length);
    const finished = rest.length === 0;
    await db
      .updateTable("track_bulk_operation")
      .set({
        pending_json: JSON.stringify(rest),
        done: op.done + batch.length,
        errors_json: JSON.stringify(errors),
        state: finished ? "finished" : "running",
        finished_at: finished ? new Date() : null,
      })
      .where("id", "=", op.id)
      .execute();
    if (finished) {
      await ctx.emit(db, {
        type: "bulk.finished",
        actorId: op.actor_id,
        entityType: "bulk",
        entityId: op.id,
        payload: { total: op.total, failed: errors.length },
      });
    } else {
      await ctx.queue.enqueue(db as unknown as Kysely<CoreDb>, JOB, {
        id: op.id,
      });
    }
  });

  const r = scope.withTypeProvider<ZodTypeProvider>();
  const own = { permission: "authenticated" as const };

  r.post(
    "/bulk",
    {
      config: own,
      schema: {
        body: z.object({
          /** Ticket keys. Take them from a query result's issue_key column. */
          keys: z.array(z.string().max(30)).min(1).max(MAX),
          action,
        }),
        response: { 202: statusSchema },
      },
    },
    async (req, reply) => {
      const actor = requireUser(req);
      const keys = [...new Set(req.body.keys.map((k) => k.toUpperCase()))];
      if (
        req.body.action.kind === "edit" &&
        Object.keys(req.body.action.fields).length === 0
      ) {
        throw new AppError(
          400,
          "validation",
          "Choose at least one field to change",
        );
      }
      return reply
        .status(202)
        .send(await queueBulk(ctx, actor, req.body.action, keys));
    },
  );

  r.get(
    "/bulk/:id",
    {
      config: own,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: statusSchema },
      },
    },
    async (req) => {
      const op = await db
        .selectFrom("track_bulk_operation")
        .selectAll()
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      // Only the person who started it sees it.
      if (!op || op.actor_id !== requireUser(req).id)
        throw new AppError(404, "not_found", "Not found");
      return {
        id: op.id,
        state: op.state,
        total: op.total,
        done: op.done,
        errors: JSON.parse(op.errors_json),
      };
    },
  );
}

/** Starts a bulk job over `items` (ticket keys, or JSON for "create") as `actor`. */
export async function queueBulk(
  ctx: TrackContext,
  actor: AuthUser,
  a: Action,
  items: string[],
): Promise<Status> {
  const op: TrackDb["track_bulk_operation"] = {
    id: uuidv7(),
    actor_id: actor.id,
    action_json: JSON.stringify(a),
    pending_json: JSON.stringify(items),
    total: items.length,
    done: 0,
    errors_json: "[]",
    state: "running",
    created_at: new Date(),
    finished_at: null,
  };
  await ctx.db.transaction().execute(async (trx) => {
    await trx.insertInto("track_bulk_operation").values(op).execute();
    await ctx.queue.enqueue(trx as unknown as Kysely<CoreDb>, JOB, {
      id: op.id,
    });
  });
  return { id: op.id, state: op.state, total: op.total, done: 0, errors: [] };
}
