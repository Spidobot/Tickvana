// Customer satisfaction: when a request is done, its reporter is asked for a
// rating from 1 to 5. The rating lives in the field "satisfaction", so queries
// and reports see it like any other field.
import {
  AppError,
  requireUser,
  type AppContext,
  type CoreDb,
  type StoredEvent,
} from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import { issueTarget } from "./access.js";
import type { TrackContext } from "./context.js";
import {
  normalizeCustomValues,
  writeCustomValues,
  type Field,
} from "./fields.js";
import type { IssueService } from "./issues.js";
import { addComment } from "./routes/issue-parts.js";

export function installSatisfaction(
  scope: FastifyInstance,
  ctx: TrackContext,
  app: AppContext,
  issues: IssueService,
): void {
  const { db, access } = ctx;
  const core = db as unknown as Kysely<CoreDb>;
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const field = () =>
    db
      .selectFrom("track_field")
      .selectAll()
      .where("key", "=", "satisfaction")
      .executeTakeFirstOrThrow() as Promise<Field>;
  const current = async (issueId: string) => {
    const f = await field();
    const row = await db
      .selectFrom("track_issue_field_value")
      .select("value_number")
      .where("issue_id", "=", issueId)
      .where("field_id", "=", f.id)
      .executeTakeFirst();
    return row?.value_number ?? null;
  };

  // Ask the reporter once a portal request is done.
  app.queue.on(
    "track-satisfaction-mail",
    ["issue.transitioned"],
    async (event: StoredEvent) => {
      const issue = await db
        .selectFrom("track_issue as i")
        .innerJoin("track_status as s", "s.id", "i.status_id")
        .innerJoin("core_user as u", "u.id", "i.reporter_id")
        .select([
          "i.id",
          "i.key",
          "i.summary",
          "i.request_type_id",
          "s.category",
          "u.email",
          "u.locale",
          "u.active",
        ])
        .where("i.id", "=", event.entityId)
        .executeTakeFirst();
      if (!issue?.request_type_id || issue.category !== "done" || !issue.active)
        return;
      if ((await current(issue.id)) !== null) return;
      const de = issue.locale.startsWith("de");
      await app.mailer.send(core, {
        to: issue.email,
        subject: de
          ? `[${issue.key}] Wie zufrieden bist du?`
          : `[${issue.key}] How did we do?`,
        body: [
          de
            ? `Deine Anfrage „${issue.summary}" ist erledigt. Magst du sie bewerten?`
            : `Your request "${issue.summary}" is done. Would you rate it?`,
        ],
        action: {
          label: de ? "Bewerten" : "Rate",
          url: `${app.baseUrl}/portal/requests/${issue.key}`,
        },
      });
    },
  );

  r.get(
    "/portal/requests/:key/rating",
    {
      config: { permission: "authenticated" as const, customers: true },
      schema: {
        params: z.object({ key: z.string().max(30) }),
        response: {
          200: z.object({ canRate: z.boolean(), score: z.number().nullable() }),
        },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const issue = await issues.load(user, req.params.key);
      const status = await db
        .selectFrom("track_status")
        .select("category")
        .where("id", "=", issue.status_id)
        .executeTakeFirstOrThrow();
      const score = await current(issue.id);
      return {
        canRate:
          issue.reporter_id === user.id &&
          status.category === "done" &&
          score === null,
        score,
      };
    },
  );

  r.post(
    "/portal/requests/:key/rating",
    {
      config: { permission: "authenticated" as const, customers: true },
      schema: {
        params: z.object({ key: z.string().max(30) }),
        body: z.object({
          score: z.number().int().min(1).max(5),
          comment: z.string().max(2000).default(""),
        }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const issue = await issues.load(user, req.params.key);
      if (issue.reporter_id !== user.id)
        throw new AppError(
          403,
          "forbidden",
          "Only the reporter rates a request",
        );
      const status = await db
        .selectFrom("track_status")
        .select("category")
        .where("id", "=", issue.status_id)
        .executeTakeFirstOrThrow();
      if (status.category !== "done")
        throw new AppError(409, "conflict", "The request is not done yet");
      if ((await current(issue.id)) !== null)
        throw new AppError(409, "conflict", "Already rated");
      const f = await field();
      // Written as a value of the ticket, without the edit permission a customer lacks.
      await db.transaction().execute(async (trx) => {
        await writeCustomValues(
          trx,
          issue.id,
          await normalizeCustomValues(trx, [f], {
            satisfaction: req.body.score,
          }),
        );
        await ctx.emit(trx, {
          type: "issue.rated",
          actorId: user.id,
          entityType: "issue",
          entityId: issue.id,
          payload: { key: issue.key, score: req.body.score },
        });
      });
      if (
        req.body.comment.trim() &&
        (await access.can(user, "issue.comment", issueTarget(issue)))
      )
        await addComment(
          ctx,
          issues,
          user,
          issue.key,
          {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: req.body.comment.trim() }],
              },
            ],
          },
          "public",
        );
      return reply.status(204).send(null);
    },
  );

  /** Ratings of a project: average, count and how often each score was given. */
  r.get(
    "/projects/:key/satisfaction",
    {
      config: { permission: "custom" as const },
      schema: {
        params: z.object({ key: z.string().max(10) }),
        response: {
          200: z.object({
            count: z.number(),
            average: z.number().nullable(),
            distribution: z.array(z.number()),
          }),
        },
      },
    },
    async (req) => {
      const project = await ctx.project(requireUser(req), req.params.key);
      const f = await field();
      const rows = await db
        .selectFrom("track_issue_field_value as v")
        .innerJoin("track_issue as i", "i.id", "v.issue_id")
        .select([
          "v.value_number",
          "i.project_id",
          "i.reporter_id",
          "i.assignee_id",
          "i.security_level_id",
        ])
        .where("v.field_id", "=", f.id)
        .where("i.project_id", "=", project.id)
        .execute();
      const scores: number[] = [];
      for (const row of rows)
        if (
          !row.security_level_id ||
          (await access.can(
            requireUser(req),
            "project.browse",
            issueTarget(row),
          ))
        )
          if (row.value_number !== null) scores.push(row.value_number);
      const distribution = [1, 2, 3, 4, 5].map(
        (s) => scores.filter((x) => x === s).length,
      );
      return {
        count: scores.length,
        average: scores.length
          ? Math.round(
              (scores.reduce((a, b) => a + b, 0) / scores.length) * 10,
            ) / 10
          : null,
        distribution,
      };
    },
  );
}
