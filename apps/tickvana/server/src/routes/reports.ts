// Board reports: burndown, velocity, cumulative flow, cycle time. All are
// computed from the change history, for the tickets the viewer may see on the
// board, so nobody learns about tickets through a chart.
import {
  AppError,
  requireUser,
  type AppContext,
  type AuthUser,
} from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { issueTarget } from "../access.js";
import type { TrackContext } from "../context.js";
import type { StatusCategory, TrackDb } from "../db/schema.js";

const DAY = 86_400_000;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const endOfDay = (day: string) => new Date(`${day}T23:59:59.999Z`);
function days(from: Date, to: Date): string[] {
  const out: string[] = [];
  for (let t = Date.parse(dayOf(from)); t <= to.getTime(); t += DAY)
    out.push(dayOf(new Date(t)));
  return out;
}

export async function reportRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
  app: AppContext,
): Promise<void> {
  const { db, access } = ctx;
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const custom = { permission: "custom" as const };
  const idParam = z.object({ id: z.string() });

  /** The board and the tickets on it that the user may see. */
  async function boardIssues(user: AuthUser, boardId: string) {
    const board = await db
      .selectFrom("track_board")
      .selectAll()
      .where("id", "=", boardId)
      .executeTakeFirst();
    if (!board) throw new AppError(404, "not_found", "Not found");
    const result = await app.savedQueries.run(user, board.query_id, {
      limit: 5000,
    });
    const ids = result.rows.map((row) => String(row.id));
    const rows = ids.length
      ? await db
          .selectFrom("track_issue")
          .selectAll()
          .where("id", "in", ids)
          .execute()
      : [];
    return { board, issues: rows };
  }

  /** Category of every status, and the status history of tickets as [time, status id] steps. */
  async function history(issues: TrackDb["track_issue"][]) {
    const categories = new Map(
      (
        await db.selectFrom("track_status").select(["id", "category"]).execute()
      ).map((s) => [s.id, s.category as StatusCategory]),
    );
    const ids = issues.map((i) => i.id);
    const changes = ids.length
      ? await db
          .selectFrom("track_issue_change as c")
          .innerJoin("track_issue_change_item as it", "it.change_id", "c.id")
          .select([
            "c.issue_id",
            "c.created_at",
            "it.from_value",
            "it.to_value",
          ])
          .where("c.issue_id", "in", ids)
          .where("it.field_key", "=", "status")
          .orderBy("c.created_at")
          .orderBy("c.id")
          .execute()
      : [];
    const steps = new Map<string, { at: Date; status: string }[]>();
    for (const issue of issues) {
      const own = changes.filter((c) => c.issue_id === issue.id);
      // The first change knows the status the ticket was created in.
      const initial = own[0]?.from_value ?? issue.status_id;
      steps.set(issue.id, [
        { at: issue.created_at, status: initial },
        ...own.map((c) => ({
          at: c.created_at,
          status: c.to_value ?? initial,
        })),
      ]);
    }
    /** Status of a ticket at a moment, or undefined before it existed. */
    const statusAt = (issueId: string, at: Date) => {
      let current: string | undefined;
      for (const step of steps.get(issueId) ?? []) {
        if (step.at > at) break;
        current = step.status;
      }
      return current;
    };
    const categoryAt = (issueId: string, at: Date) => {
      const status = statusAt(issueId, at);
      return status ? categories.get(status) : undefined;
    };
    return { steps, categories, categoryAt };
  }

  r.get(
    "/boards/:id/reports/burndown",
    {
      config: custom,
      schema: {
        params: idParam,
        querystring: z.object({ sprintId: z.string().optional() }),
        response: {
          200: z.object({
            sprint: z.object({
              id: z.string(),
              name: z.string(),
              startAt: z.string(),
              endAt: z.string(),
            }),
            /** Remaining estimate in seconds at the end of each day; null for days still to come. */
            points: z.array(
              z.object({
                day: z.string(),
                remainingSec: z.number().nullable(),
                idealSec: z.number(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const { board, issues } = await boardIssues(user, req.params.id);
      let query = db
        .selectFrom("track_sprint")
        .selectAll()
        .where("board_id", "=", board.id);
      query = req.query.sprintId
        ? query.where("id", "=", req.query.sprintId)
        : query
            .where("state", "in", ["active", "closed"])
            .orderBy("start_at", "desc");
      const sprint = await query.executeTakeFirst();
      if (!sprint?.start_at || !sprint.end_at)
        throw new AppError(404, "not_found", "No started sprint");

      const members = await db
        .selectFrom("track_sprint_issue")
        .selectAll()
        .where("sprint_id", "=", sprint.id)
        .execute();
      const visible = new Map(issues.map((i) => [i.id, i]));
      const inSprint = members.filter((m) => visible.has(m.issue_id));
      const { categoryAt } = await history(
        inSprint.map((m) => visible.get(m.issue_id)!),
      );
      const estimate = (id: string) => visible.get(id)?.estimate_sec ?? 0;

      const now = new Date();
      const timeline = days(sprint.start_at, sprint.end_at);
      const committed = inSprint
        .filter((m) => m.added_at <= sprint.start_at!)
        .reduce((sum, m) => sum + estimate(m.issue_id), 0);
      return {
        sprint: {
          id: sprint.id,
          name: sprint.name,
          startAt: sprint.start_at.toISOString(),
          endAt: sprint.end_at.toISOString(),
        },
        points: timeline.map((day, i) => {
          const at = endOfDay(day);
          const remaining =
            at > now && day !== dayOf(now)
              ? null
              : inSprint
                  // In the sprint that day, and not done yet.
                  .filter(
                    (m) =>
                      m.added_at <= at &&
                      (m.removed_at === null || m.removed_at > at) &&
                      categoryAt(m.issue_id, at) !== "done",
                  )
                  .reduce((sum, m) => sum + estimate(m.issue_id), 0);
          return {
            day,
            remainingSec: remaining,
            idealSec: Math.round(
              committed * (1 - i / Math.max(1, timeline.length - 1)),
            ),
          };
        }),
      };
    },
  );

  r.get(
    "/boards/:id/reports/velocity",
    {
      config: custom,
      schema: {
        params: idParam,
        response: {
          200: z.array(
            z.object({
              sprintId: z.string(),
              name: z.string(),
              committedSec: z.number(),
              completedSec: z.number(),
            }),
          ),
        },
      },
    },
    async (req) => {
      const { board, issues } = await boardIssues(
        requireUser(req),
        req.params.id,
      );
      const visible = new Map(issues.map((i) => [i.id, i]));
      const sprints = await db
        .selectFrom("track_sprint")
        .selectAll()
        .where("board_id", "=", board.id)
        .where("state", "=", "closed")
        .orderBy("end_at")
        .execute();
      const out = [];
      for (const s of sprints.slice(-10)) {
        const members = (
          await db
            .selectFrom("track_sprint_issue")
            .selectAll()
            .where("sprint_id", "=", s.id)
            .execute()
        ).filter((m) => visible.has(m.issue_id));
        const sum = (list: typeof members) =>
          list.reduce(
            (total, m) => total + (visible.get(m.issue_id)!.estimate_sec ?? 0),
            0,
          );
        // Completed: still in the sprint when it closed (carried-over ones got removed_at).
        out.push({
          sprintId: s.id,
          name: s.name,
          committedSec: sum(
            members.filter((m) => m.added_at <= (s.start_at ?? s.end_at!)),
          ),
          completedSec: sum(members.filter((m) => m.removed_at === null)),
        });
      }
      return out;
    },
  );

  r.get(
    "/boards/:id/reports/flow",
    {
      config: custom,
      schema: {
        params: idParam,
        querystring: z.object({
          days: z.coerce.number().int().min(7).max(180).default(30),
        }),
        response: {
          200: z.array(
            z.object({
              day: z.string(),
              todo: z.number(),
              inProgress: z.number(),
              done: z.number(),
            }),
          ),
        },
      },
    },
    async (req) => {
      const { issues } = await boardIssues(requireUser(req), req.params.id);
      const { categoryAt } = await history(issues);
      const now = new Date();
      return days(
        new Date(now.getTime() - (req.query.days - 1) * DAY),
        now,
      ).map((day) => {
        const at = endOfDay(day);
        const count = { todo: 0, inProgress: 0, done: 0 };
        for (const issue of issues) {
          const category = categoryAt(issue.id, at);
          if (category === "todo") count.todo++;
          else if (category === "in_progress") count.inProgress++;
          else if (category === "done") count.done++;
        }
        return { day, ...count };
      });
    },
  );

  r.get(
    "/boards/:id/reports/cycle-time",
    {
      config: custom,
      schema: {
        params: idParam,
        response: {
          200: z.object({
            averageHours: z.number().nullable(),
            medianHours: z.number().nullable(),
            /** Per finished ticket: from first entering work to done. */
            issues: z.array(
              z.object({
                key: z.string(),
                doneAt: z.string(),
                hours: z.number(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const { issues } = await boardIssues(user, req.params.id);
      const finished = [];
      for (const issue of issues)
        if (
          issue.resolved_at &&
          (await access.can(user, "project.browse", issueTarget(issue)))
        )
          finished.push(issue);
      const { steps, categories } = await history(finished);
      const rows = finished
        .map((issue) => {
          const path = steps.get(issue.id) ?? [];
          // Work starts at the first step into "in progress"; without one, at creation.
          const started =
            path.find((s) => categories.get(s.status) === "in_progress")?.at ??
            issue.created_at;
          return {
            key: issue.key,
            doneAt: issue.resolved_at!.toISOString(),
            hours: Math.max(
              0,
              (issue.resolved_at!.getTime() - started.getTime()) / 3_600_000,
            ),
          };
        })
        .sort((a, b) => a.doneAt.localeCompare(b.doneAt));
      const hours = rows.map((x) => x.hours).sort((a, b) => a - b);
      const round = (n: number) => Math.round(n * 10) / 10;
      return {
        averageHours: hours.length
          ? round(hours.reduce((a, b) => a + b, 0) / hours.length)
          : null,
        medianHours: hours.length
          ? round(
              hours.length % 2
                ? hours[(hours.length - 1) / 2]!
                : (hours[hours.length / 2 - 1]! + hours[hours.length / 2]!) / 2,
            )
          : null,
        issues: rows.map((x) => ({ ...x, hours: round(x.hours) })),
      };
    },
  );
}
