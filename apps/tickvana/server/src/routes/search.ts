// Quick search for the command palette: key, summary and description text,
// only tickets the reader may see. The query language (Q-*) is for the rest.
import { escapeLike, excerpt, likeCi, requireUser } from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { issueTarget } from "../access.js";
import type { TrackContext } from "../context.js";

export async function searchRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
): Promise<void> {
  const { db, access } = ctx;
  scope.withTypeProvider<ZodTypeProvider>().get(
    "/search",
    {
      config: { permission: "authenticated" as const },
      schema: {
        querystring: z.object({
          q: z.string().trim().min(2).max(200),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        }),
        response: {
          200: z.array(
            z.object({
              key: z.string(),
              summary: z.string(),
              excerpt: z.string(),
            }),
          ),
        },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const { q, limit } = req.query;
      const projectIds = await access.visibleProjectIds(user);
      if (!projectIds.length) return [];
      const pattern = `%${escapeLike(q)}%`;
      const rows = await db
        .selectFrom("track_issue")
        .selectAll()
        .where("project_id", "in", projectIds)
        .where((eb) =>
          eb.or([
            eb("key", "=", q.toUpperCase()),
            likeCi(eb.ref("summary"), pattern),
            likeCi(eb.ref("description_text"), pattern),
          ]),
        )
        .orderBy("updated_at", "desc")
        // Security levels are checked one by one below; fetch some extra.
        .limit(limit * 3)
        .execute();
      const out: { key: string; summary: string; excerpt: string }[] = [];
      for (const i of rows) {
        if (out.length === limit) break;
        if (!(await access.can(user, "project.browse", issueTarget(i))))
          continue;
        out.push({
          key: i.key,
          summary: i.summary,
          excerpt: i.summary.toLowerCase().includes(q.toLowerCase())
            ? ""
            : excerpt(i.description_text, q),
        });
      }
      // An exact key first, then summary hits.
      const lower = q.toLowerCase();
      const rank = (x: { key: string; summary: string }) =>
        x.key === q.toUpperCase()
          ? 2
          : Number(x.summary.toLowerCase().includes(lower));
      return out.sort((a, b) => rank(b) - rank(a));
    },
  );
}
