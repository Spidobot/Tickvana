import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { TrackContext } from "../context.js";

const named = z.object({ id: z.string(), name: z.string() });

/** The small lookup tables every screen needs, in one request. */
export async function metaRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
): Promise<void> {
  const { db } = ctx;
  scope.withTypeProvider<ZodTypeProvider>().get(
    "/meta",
    {
      config: { permission: "authenticated" as const, customers: true },
      schema: {
        response: {
          200: z.object({
            issueTypes: z.array(
              named.extend({ icon: z.string(), level: z.number() }),
            ),
            statuses: z.array(
              named.extend({
                category: z.enum(["todo", "in_progress", "done"]),
              }),
            ),
            priorities: z.array(
              named.extend({ position: z.number(), color: z.string() }),
            ),
            resolutions: z.array(named),
            /** May the caller create projects? */
            canCreateProject: z.boolean(),
          }),
        },
      },
    },
    async (req) => {
      const [issueTypes, statuses, priorities, resolutions] = await Promise.all(
        [
          db
            .selectFrom("track_issue_type")
            .selectAll()
            .orderBy("level", "desc")
            .orderBy("name")
            .execute(),
          db.selectFrom("track_status").selectAll().orderBy("name").execute(),
          db
            .selectFrom("track_priority")
            .selectAll()
            .orderBy("position")
            .execute(),
          db
            .selectFrom("track_resolution")
            .selectAll()
            .orderBy("name")
            .execute(),
        ],
      );
      return {
        issueTypes,
        statuses,
        priorities,
        resolutions,
        canCreateProject: await ctx.permissions.can(req.user, "project.create"),
      };
    },
  );
}
