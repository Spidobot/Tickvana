// Epics of a project with their progress: how many of the tickets under
// them are done, by count and by estimate. Only tickets the viewer may see
// count, so progress never reveals hidden work.
import { requireUser } from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { issueTarget } from "../access.js";
import type { TrackContext } from "../context.js";

export async function epicRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
): Promise<void> {
  const { db, access } = ctx;
  scope.withTypeProvider<ZodTypeProvider>().get(
    "/projects/:key/epics",
    {
      config: { permission: "custom" as const },
      schema: {
        params: z.object({ key: z.string().max(10) }),
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              key: z.string(),
              summary: z.string(),
              statusId: z.string(),
              done: z.boolean(),
              total: z.number(),
              doneCount: z.number(),
              estimateSec: z.number(),
              doneEstimateSec: z.number(),
            }),
          ),
        },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const project = await ctx.project(user, req.params.key);
      const epics = await db
        .selectFrom("track_issue as i")
        .innerJoin("track_issue_type as t", "t.id", "i.type_id")
        .selectAll("i")
        .where("i.project_id", "=", project.id)
        .where("t.level", "=", 1)
        .orderBy("i.rank")
        .execute();
      const visible: typeof epics = [];
      for (const epic of epics)
        if (await access.can(user, "project.browse", issueTarget(epic)))
          visible.push(epic);
      if (visible.length === 0) return [];

      const doneStatuses = new Set(
        (
          await db
            .selectFrom("track_status")
            .select("id")
            .where("category", "=", "done")
            .execute()
        ).map((s) => s.id),
      );
      const children = await db
        .selectFrom("track_issue")
        .selectAll()
        .where(
          "parent_id",
          "in",
          visible.map((e) => e.id),
        )
        .execute();
      const seen: typeof children = [];
      for (const child of children)
        if (
          !child.security_level_id ||
          (await access.can(user, "project.browse", issueTarget(child)))
        )
          seen.push(child);

      return visible.map((epic) => {
        const own = seen.filter((c) => c.parent_id === epic.id);
        const finished = own.filter((c) => doneStatuses.has(c.status_id));
        const sum = (list: typeof own) =>
          list.reduce((total, c) => total + (c.estimate_sec ?? 0), 0);
        return {
          id: epic.id,
          key: epic.key,
          summary: epic.summary,
          statusId: epic.status_id,
          done: doneStatuses.has(epic.status_id),
          total: own.length,
          doneCount: finished.length,
          estimateSec: sum(own),
          doneEstimateSec: sum(finished),
        };
      });
    },
  );
}
