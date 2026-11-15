// Approvals: a workflow step asks people for a yes or no (post function
// "requestApproval", validator "approved"). They decide on the ticket, in
// the portal or through a signed link in the mail they get.
import {
  AppError,
  requireUser,
  type AppContext,
  type AuthUser,
  type CoreDb,
  type StoredEvent,
} from "@tvn/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { TrackContext } from "./context.js";
import type { IssueService } from "./issues.js";

const decision = z.enum(["approved", "declined"]);
type Decision = z.infer<typeof decision>;
const approvalOut = z.object({
  id: z.string(),
  approverId: z.string(),
  decision: decision.nullable(),
  decidedAt: z.string().nullable(),
});

export function installApprovals(
  scope: FastifyInstance,
  ctx: TrackContext,
  app: AppContext,
  issues: IssueService,
): void {
  const { db } = ctx;
  const core = db as unknown as Kysely<CoreDb>;
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const token = (id: string, d: Decision) =>
    app.secrets.sign(`approval:${id}:${d}`);
  const linkFor = (id: string, d: Decision) =>
    `${app.baseUrl}/api/approvals/${id}/mail?decision=${d}&token=${token(id, d)}`;

  /** Records a decision once; emits approval.decided for automations and the workflow. */
  async function decide(id: string, d: Decision, actorId: string) {
    const a = await db
      .selectFrom("track_approval")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!a) throw new AppError(404, "not_found", "Not found");
    if (a.decision) throw new AppError(409, "conflict", "Already decided");
    await db.transaction().execute(async (trx) => {
      const res = await trx
        .updateTable("track_approval")
        .set({ decision: d, decided_at: new Date() })
        .where("id", "=", id)
        .where("decision", "is", null)
        .executeTakeFirst();
      if (res.numUpdatedRows === 0n)
        throw new AppError(409, "conflict", "Already decided");
      await ctx.emit(trx, {
        type: "approval.decided",
        actorId,
        entityType: "issue",
        entityId: a.issue_id,
        payload: { approvalId: id, decision: d },
      });
    });
    return a;
  }

  // The mail to each approver, after the transition that asked.
  app.queue.on(
    "track-approval-mail",
    ["approval.requested"],
    async (event: StoredEvent) => {
      const { key, approvalIds } = event.payload as {
        key: string;
        approvalIds: string[];
      };
      const issue = await db
        .selectFrom("track_issue")
        .select(["summary"])
        .where("id", "=", event.entityId)
        .executeTakeFirst();
      if (!issue) return;
      const rows = await db
        .selectFrom("track_approval as a")
        .innerJoin("core_user as u", "u.id", "a.approver_id")
        .select(["a.id", "u.email", "u.locale", "u.active"])
        .where("a.id", "in", approvalIds)
        .execute();
      for (const a of rows.filter((x) => x.active)) {
        const de = a.locale.startsWith("de");
        await app.mailer.send(core, {
          to: a.email,
          subject: de
            ? `[${key}] Freigabe erbeten: ${issue.summary}`
            : `[${key}] Approval requested: ${issue.summary}`,
          body: [
            de
              ? `Bitte gib ${key} frei oder lehne ab: ${issue.summary}`
              : `Please approve or decline ${key}: ${issue.summary}`,
            `${de ? "Ablehnen" : "Decline"}: ${linkFor(a.id, "declined")}`,
          ],
          action: {
            label: de ? "Freigeben" : "Approve",
            url: linkFor(a.id, "approved"),
          },
        });
      }
    },
  );

  r.get(
    "/issues/:key/approvals",
    {
      config: { permission: "custom" as const, customers: true },
      schema: {
        params: z.object({ key: z.string().max(36) }),
        response: { 200: z.array(approvalOut) },
      },
    },
    async (req) => {
      const issue = await issues.load(req.user, req.params.key);
      const rows = await db
        .selectFrom("track_approval")
        .selectAll()
        .where("issue_id", "=", issue.id)
        .orderBy("id")
        .execute();
      return rows.map((a) => ({
        id: a.id,
        approverId: a.approver_id,
        decision: a.decision,
        decidedAt: a.decided_at?.toISOString() ?? null,
      }));
    },
  );

  r.post(
    "/approvals/:id/decision",
    {
      config: { permission: "authenticated" as const, customers: true },
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ decision }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const user: AuthUser = requireUser(req);
      const a = await db
        .selectFrom("track_approval")
        .select("approver_id")
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (!a || a.approver_id !== user.id)
        throw new AppError(404, "not_found", "Not found");
      await decide(req.params.id, req.body.decision, user.id);
      return reply.status(204).send(null);
    },
  );

  /** The link in the mail: works without signing in, only with the signature for this decision. */
  r.get(
    "/approvals/:id/mail",
    {
      config: {
        permission: "public" as const,
        customers: true,
      },
      schema: {
        params: z.object({ id: z.string() }),
        querystring: z.object({ decision, token: z.string().max(100) }),
      },
    },
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Querystring: { decision: Decision; token: string };
      }>,
      reply,
    ) => {
      const { decision: d, token: given } = req.query;
      if (given !== token(req.params.id, d))
        throw new AppError(403, "forbidden", "This link is not valid");
      const a = await db
        .selectFrom("track_approval")
        .selectAll()
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (!a) throw new AppError(404, "not_found", "Not found");
      if (!a.decision) await decide(a.id, d, a.approver_id);
      const issue = await db
        .selectFrom("track_issue")
        .select("key")
        .where("id", "=", a.issue_id)
        .executeTakeFirstOrThrow();
      return reply.redirect(
        `${app.baseUrl}/portal/requests/${issue.key}?decided=${a.decision ?? d}`,
      );
    },
  );

  r.get(
    "/portal/approvals",
    {
      config: { permission: "authenticated" as const, customers: true },
      schema: {
        response: {
          200: z.array(
            z.object({ id: z.string(), key: z.string(), summary: z.string() }),
          ),
        },
      },
    },
    async (req) =>
      db
        .selectFrom("track_approval as a")
        .innerJoin("track_issue as i", "i.id", "a.issue_id")
        .select(["a.id", "i.key", "i.summary"])
        .where("a.approver_id", "=", requireUser(req).id)
        .where("a.decision", "is", null)
        .orderBy("a.id")
        .execute(),
  );
}
