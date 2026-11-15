import { AppError, requireUser } from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { issueTarget } from "../access.js";
import type { TrackContext } from "../context.js";
import type { IssueService } from "../issues.js";
import { placeBetween } from "../rank.js";

/**
 * POST /issues/:key/rank: put a ticket between two neighbours, as the client
 * sees them (a board column, the backlog). Either neighbour may be missing at
 * the start or end of the list.
 */
export async function rankRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
  issues: IssueService,
): Promise<void> {
  const { db, access } = ctx;
  const r = scope.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/issues/:key/rank",
    {
      config: { permission: "custom" as const },
      schema: {
        params: z.object({ key: z.string().max(30) }),
        body: z.object({
          afterKey: z.string().max(30).optional(),
          beforeKey: z.string().max(30).optional(),
        }),
        response: { 200: z.object({ rank: z.string() }) },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const issue = await issues.load(user, req.params.key);
      // Ordering is a kind of editing, but a scheme can grant it separately later.
      await access.require(user, "issue.edit", issueTarget(issue));
      const neighbour = async (key: string | undefined) =>
        key ? (await issues.load(user, key)).id : undefined;
      const [afterId, beforeId] = [
        await neighbour(req.body.afterKey),
        await neighbour(req.body.beforeKey),
      ];
      if (!afterId && !beforeId)
        throw new AppError(
          400,
          "validation",
          "Give the ticket before or after the new position",
        );
      if (afterId === issue.id || beforeId === issue.id)
        throw new AppError(
          400,
          "validation",
          "A ticket cannot be its own neighbour",
        );

      const rank = await placeBetween(db, issue.id, afterId, beforeId);
      if (!rank)
        throw new AppError(
          409,
          "conflict",
          "The list changed in the meantime. Reload and try again",
        );
      return { rank };
    },
  );
}
