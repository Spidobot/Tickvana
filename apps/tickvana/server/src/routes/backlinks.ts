// Pages that mention a ticket, from core_link. Only ids: the browser asks
// Nuvenna for each title with the reader's own rights (CONCEPT.md §2).
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import type { CoreDb } from "@tvn/core";
import { z } from "zod";
import type { TrackContext } from "../context.js";
import type { IssueService } from "../issues.js";

export async function backlinkRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
  issues: IssueService,
): Promise<void> {
  const core = ctx.db as unknown as Kysely<CoreDb>;
  scope.withTypeProvider<ZodTypeProvider>().get(
    "/issues/:key/pages",
    {
      config: { permission: "custom" as const },
      schema: {
        params: z.object({ key: z.string().max(36) }),
        response: { 200: z.object({ pageIds: z.array(z.string()) }) },
      },
    },
    async (req) => {
      const issue = await issues.get(req.user, req.params.key);
      // Nuvenna may still name the ticket by a key from before a move.
      const old = await ctx.db
        .selectFrom("track_issue_change_item as ci")
        .innerJoin("track_issue_change as c", "c.id", "ci.change_id")
        .select("ci.from_value")
        .where("c.issue_id", "=", issue.id)
        .where("ci.field_key", "=", "key")
        .execute();
      const keys = [
        issue.key,
        ...old.flatMap((o) => (o.from_value ? [o.from_value] : [])),
      ];
      const [mentioned, linked] = await Promise.all([
        core
          .selectFrom("core_link")
          .select("from_id as id")
          .where("from_type", "=", "page")
          .where("to_type", "=", "issue")
          .where("to_id", "in", keys)
          .execute(),
        core
          .selectFrom("core_link")
          .select("to_id as id")
          .where("from_type", "=", "issue")
          .where("from_id", "in", keys)
          .where("to_type", "=", "page")
          .execute(),
      ]);
      return {
        pageIds: [...new Set([...mentioned, ...linked].map((x) => x.id))],
      };
    },
  );
}
