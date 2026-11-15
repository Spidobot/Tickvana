// SLA clocks. A policy says which events start a ticket's clock, in which
// statuses it pauses, what stops it, and how much working time the ticket
// gets (first matching goal wins). Everything is driven by core_event; a job
// marks running clocks as breached and emits sla.breached.
import { uuidv7, type AppContext, type StoredEvent } from "@tvn/core";
import { z } from "zod";
import type { TrackContext } from "./context.js";
import type { TrackDb } from "./db/schema.js";
import {
  addBusinessTime,
  businessTimeBetween,
  type Calendar,
} from "./sla-time.js";

export const startSchema = z.object({
  events: z.array(z.string()).default(["issue.created"]),
});
export const pauseSchema = z.object({
  statusIds: z.array(z.string()).default([]),
});
export const stopSchema = z.object({
  /** Event types; "first_response" is a public comment by someone other than the reporter. */
  events: z.array(z.string()).default([]),
  statusIds: z.array(z.string()).default([]),
  statusCategories: z
    .array(z.enum(["todo", "in_progress", "done"]))
    .default([]),
});
export const goalsSchema = z
  .array(
    z.object({
      priorityIds: z.array(z.string()).default([]),
      requestTypeIds: z.array(z.string()).default([]),
      minutes: z.number().int().min(1).max(525_600),
    }),
  )
  .min(1);
export const calendarHours = z.partialRecord(
  z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
  z.array(
    z.tuple([
      z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/),
    ]),
  ),
);

type Policy = TrackDb["track_sla_policy"];
type Cycle = TrackDb["track_sla_cycle"];
type Issue = TrackDb["track_issue"];

export const calendarOf = (row: TrackDb["track_calendar"]): Calendar => ({
  timezone: row.timezone,
  hours: JSON.parse(row.hours_json),
  holidays: JSON.parse(row.holidays_json),
});

/** Working minutes the ticket gets under a policy, or null when no goal applies. */
export function goalFor(policy: Policy, issue: Issue): number | null {
  for (const g of goalsSchema.parse(JSON.parse(policy.goals_json))) {
    if (g.priorityIds.length && !g.priorityIds.includes(issue.priority_id))
      continue;
    if (
      g.requestTypeIds.length &&
      !g.requestTypeIds.includes(issue.request_type_id ?? "")
    )
      continue;
    return g.minutes;
  }
  return null;
}

export function createSla(ctx: TrackContext, app: AppContext) {
  const { db } = ctx;

  async function calendar(id: string) {
    return calendarOf(
      await db
        .selectFrom("track_calendar")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow(),
    );
  }

  async function onEvent(event: StoredEvent) {
    if (event.entityType !== "issue") return;
    const issue = await db
      .selectFrom("track_issue")
      .selectAll()
      .where("id", "=", event.entityId)
      .executeTakeFirst();
    if (!issue) return;
    const policies = await db
      .selectFrom("track_sla_policy")
      .selectAll()
      .where("project_id", "=", issue.project_id)
      .execute();
    if (!policies.length) return;
    const status = await db
      .selectFrom("track_status")
      .selectAll()
      .where("id", "=", issue.status_id)
      .executeTakeFirstOrThrow();
    const at = event.createdAt;

    for (const policy of policies) {
      const cal = await calendar(policy.calendar_id);
      const start = startSchema.parse(JSON.parse(policy.start_json));
      const pause = pauseSchema.parse(JSON.parse(policy.pause_json));
      const stop = stopSchema.parse(JSON.parse(policy.stop_json));
      const goal = goalFor(policy, issue);
      const open = await db
        .selectFrom("track_sla_cycle")
        .selectAll()
        .where("issue_id", "=", issue.id)
        .where("policy_id", "=", policy.id)
        .where("stopped_at", "is", null)
        .executeTakeFirst();
      const paused = pause.statusIds.includes(issue.status_id);

      if (!open) {
        if (goal === null || !start.events.includes(event.type)) continue;
        await db
          .insertInto("track_sla_cycle")
          .values({
            id: uuidv7(),
            issue_id: issue.id,
            policy_id: policy.id,
            started_at: at,
            paused_ms: 0,
            paused_at: paused ? at : null,
            due_at: addBusinessTime(cal, at, goal * 60_000),
            stopped_at: null,
            breached: false,
          })
          .execute();
        continue;
      }

      const firstResponse =
        event.type === "issue.commented" &&
        (event.payload as { visibility?: string } | null)?.visibility ===
          "public" &&
        event.actorId !== issue.reporter_id;
      const stops =
        stop.events.includes(event.type) ||
        (firstResponse && stop.events.includes("first_response")) ||
        stop.statusIds.includes(issue.status_id) ||
        stop.statusCategories.includes(status.category);
      const pausedMs = Number(open.paused_ms);
      if (stops) {
        // A clock stopped while paused keeps the time it had left.
        const stoppedEarly = open.paused_at !== null;
        await db
          .updateTable("track_sla_cycle")
          .set({
            stopped_at: at,
            paused_at: null,
            breached: open.breached || (!stoppedEarly && at > open.due_at),
          })
          .where("id", "=", open.id)
          .execute();
        continue;
      }
      if (paused && open.paused_at === null) {
        await db
          .updateTable("track_sla_cycle")
          .set({ paused_at: at })
          .where("id", "=", open.id)
          .execute();
        continue;
      }
      // Running again, or something changed that may change the goal: work out the due time anew.
      const nextPaused =
        !paused && open.paused_at
          ? pausedMs + businessTimeBetween(cal, open.paused_at, at)
          : pausedMs;
      if (goal === null) continue;
      await db
        .updateTable("track_sla_cycle")
        .set({
          paused_ms: nextPaused,
          paused_at: paused ? open.paused_at : null,
          due_at: addBusinessTime(
            cal,
            open.started_at,
            goal * 60_000 + nextPaused,
          ),
        })
        .where("id", "=", open.id)
        .execute();
    }
  }

  /** Marks running clocks past their due time as breached. Returns how many. */
  async function runBreaches(now = new Date()): Promise<number> {
    const due = await db
      .selectFrom("track_sla_cycle")
      .selectAll()
      .where("stopped_at", "is", null)
      .where("paused_at", "is", null)
      .where("breached", "=", false)
      .where("due_at", "<=", now)
      .execute();
    for (const c of due)
      await db.transaction().execute(async (trx) => {
        const res = await trx
          .updateTable("track_sla_cycle")
          .set({ breached: true })
          .where("id", "=", c.id)
          .where("breached", "=", false)
          .executeTakeFirst();
        if (res.numUpdatedRows === 0n) return;
        await ctx.emit(trx, {
          type: "sla.breached",
          actorId: null,
          entityType: "issue",
          entityId: c.issue_id,
          payload: { cycleId: c.id, policyId: c.policy_id, dueAt: c.due_at },
        });
      });
    return due.length;
  }

  app.queue.on("track-sla", ["issue.*"], onEvent);
  app.queue.every("track-sla-breaches", 60_000, async () => {
    await runBreaches();
  });

  /** Clocks of one ticket, for its page and the queues. */
  async function cyclesOf(
    issueId: string,
  ): Promise<(Cycle & { policy: string; remaining_ms: number | null })[]> {
    const rows = await db
      .selectFrom("track_sla_cycle as c")
      .innerJoin("track_sla_policy as p", "p.id", "c.policy_id")
      .selectAll("c")
      .select(["p.name as policy", "p.calendar_id"])
      .where("c.issue_id", "=", issueId)
      .orderBy("c.started_at")
      .execute();
    const now = new Date();
    return Promise.all(
      rows.map(async (c) => {
        if (c.stopped_at) return { ...c, remaining_ms: null };
        const cal = await calendar(c.calendar_id);
        const from = c.paused_at ?? now;
        const left =
          c.due_at > from
            ? businessTimeBetween(cal, from, c.due_at)
            : -businessTimeBetween(cal, c.due_at, from);
        return { ...c, remaining_ms: left };
      }),
    );
  }

  return { onEvent, runBreaches, cyclesOf };
}

export type Sla = ReturnType<typeof createSla>;

/** The clocks of a ticket, for whoever may see the ticket (staff only: customers do not get this route). */
export async function slaRoutes(
  scope: import("fastify").FastifyInstance,
  issues: import("./issues.js").IssueService,
  sla: Sla,
): Promise<void> {
  scope
    .withTypeProvider<import("fastify-type-provider-zod").ZodTypeProvider>()
    .get(
      "/issues/:key/sla",
      {
        config: { permission: "custom" as const },
        schema: {
          params: z.object({ key: z.string().max(36) }),
          response: {
            200: z.array(
              z.object({
                policy: z.string(),
                startedAt: z.string(),
                dueAt: z.string(),
                stoppedAt: z.string().nullable(),
                paused: z.boolean(),
                breached: z.boolean(),
                /** Working time left; negative when overdue; null once stopped. */
                remainingMs: z.number().nullable(),
              }),
            ),
          },
        },
      },
      async (req) => {
        const issue = await issues.load(req.user, req.params.key);
        return (await sla.cyclesOf(issue.id)).map((c) => ({
          policy: c.policy,
          startedAt: c.started_at.toISOString(),
          dueAt: c.due_at.toISOString(),
          stoppedAt: c.stopped_at?.toISOString() ?? null,
          paused: c.paused_at !== null,
          breached: Boolean(c.breached),
          remainingMs: c.remaining_ms,
        }));
      },
    );
}
