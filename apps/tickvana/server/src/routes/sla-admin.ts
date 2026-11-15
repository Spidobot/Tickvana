// Calendars (system administrators) and SLA policies per project (project
// administrators).
import { AppError, requireUser, SYSTEM_ADMIN, uuidv7 } from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { TrackContext } from "../context.js";
import {
  calendarHours,
  goalsSchema,
  pauseSchema,
  startSchema,
  stopSchema,
} from "../sla.js";

const calendarBody = z.object({
  name: z.string().trim().min(1).max(200),
  timezone: z.string().refine((tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Unknown time zone"),
  hours: calendarHours,
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(1000),
});
const policyBody = z.object({
  name: z.string().trim().min(1).max(200),
  calendarId: z.string(),
  start: startSchema,
  pause: pauseSchema,
  stop: stopSchema,
  goals: goalsSchema,
});

export async function slaAdminRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
): Promise<void> {
  const { db } = ctx;
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const admin = { permission: SYSTEM_ADMIN };
  const custom = { permission: "custom" as const };
  const idParam = z.object({ id: z.string() });
  const keyParam = z.object({ key: z.string().max(10) });

  // --- Calendars ----------------------------------------------------------------------

  const calendarOut = calendarBody.extend({ id: z.string() });
  r.get(
    "/calendars",
    {
      config: { permission: "authenticated" as const },
      schema: { response: { 200: z.array(calendarOut) } },
    },
    async () =>
      (
        await db
          .selectFrom("track_calendar")
          .selectAll()
          .orderBy("name")
          .execute()
      ).map((c) => ({
        id: c.id,
        name: c.name,
        timezone: c.timezone,
        hours: JSON.parse(c.hours_json),
        holidays: JSON.parse(c.holidays_json),
      })),
  );
  const calendarColumns = (b: z.infer<typeof calendarBody>) => ({
    name: b.name,
    timezone: b.timezone,
    hours_json: JSON.stringify(b.hours),
    holidays_json: JSON.stringify([...new Set(b.holidays)].sort()),
  });
  r.post(
    "/admin/calendars",
    {
      config: admin,
      schema: {
        body: calendarBody,
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    async (req, reply) => {
      const id = uuidv7();
      await db
        .insertInto("track_calendar")
        .values({ id, ...calendarColumns(req.body) })
        .execute();
      return reply.status(201).send({ id });
    },
  );
  r.put(
    "/admin/calendars/:id",
    { config: admin, schema: { params: idParam, body: calendarBody } },
    async (req, reply) => {
      const res = await db
        .updateTable("track_calendar")
        .set(calendarColumns(req.body))
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (res.numUpdatedRows === 0n)
        throw new AppError(404, "not_found", "Not found");
      return reply.status(204).send(null);
    },
  );
  r.delete(
    "/admin/calendars/:id",
    { config: admin, schema: { params: idParam } },
    async (req, reply) => {
      const used = await db
        .selectFrom("track_sla_policy")
        .select("id")
        .where("calendar_id", "=", req.params.id)
        .executeTakeFirst();
      if (used)
        throw new AppError(409, "conflict", "Still used by SLA policies");
      await db
        .deleteFrom("track_calendar")
        .where("id", "=", req.params.id)
        .execute();
      return reply.status(204).send(null);
    },
  );

  // --- Policies -----------------------------------------------------------------------

  const policyOut = policyBody.extend({ id: z.string() });
  const columns = async (b: z.infer<typeof policyBody>) => {
    const cal = await db
      .selectFrom("track_calendar")
      .select("id")
      .where("id", "=", b.calendarId)
      .executeTakeFirst();
    if (!cal) throw new AppError(400, "validation", "Unknown calendar");
    return {
      name: b.name,
      calendar_id: b.calendarId,
      start_json: JSON.stringify(b.start),
      pause_json: JSON.stringify(b.pause),
      stop_json: JSON.stringify(b.stop),
      goals_json: JSON.stringify(b.goals),
    };
  };
  async function loadPolicy(
    req: Parameters<typeof requireUser>[0],
    id: string,
  ) {
    const row = await db
      .selectFrom("track_sla_policy as s")
      .innerJoin("track_project as p", "p.id", "s.project_id")
      .select(["s.id", "p.key"])
      .where("s.id", "=", id)
      .executeTakeFirst();
    if (!row) throw new AppError(404, "not_found", "Not found");
    await ctx.project(requireUser(req), row.key, "project.administer");
    return row;
  }

  r.get(
    "/projects/:key/sla-policies",
    {
      config: custom,
      schema: { params: keyParam, response: { 200: z.array(policyOut) } },
    },
    async (req) => {
      const project = await ctx.project(
        requireUser(req),
        req.params.key,
        "issue.edit",
      );
      return (
        await db
          .selectFrom("track_sla_policy")
          .selectAll()
          .where("project_id", "=", project.id)
          .orderBy("name")
          .execute()
      ).map((p) => ({
        id: p.id,
        name: p.name,
        calendarId: p.calendar_id,
        start: startSchema.parse(JSON.parse(p.start_json)),
        pause: pauseSchema.parse(JSON.parse(p.pause_json)),
        stop: stopSchema.parse(JSON.parse(p.stop_json)),
        goals: goalsSchema.parse(JSON.parse(p.goals_json)),
      }));
    },
  );
  r.post(
    "/projects/:key/sla-policies",
    {
      config: custom,
      schema: {
        params: keyParam,
        body: policyBody,
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    async (req, reply) => {
      const project = await ctx.project(
        requireUser(req),
        req.params.key,
        "project.administer",
      );
      const id = uuidv7();
      await db
        .insertInto("track_sla_policy")
        .values({ id, project_id: project.id, ...(await columns(req.body)) })
        .execute();
      return reply.status(201).send({ id });
    },
  );
  r.put(
    "/sla-policies/:id",
    { config: custom, schema: { params: idParam, body: policyBody } },
    async (req, reply) => {
      const row = await loadPolicy(req, req.params.id);
      // Running clocks keep their due time until the next change of their ticket.
      await db
        .updateTable("track_sla_policy")
        .set(await columns(req.body))
        .where("id", "=", row.id)
        .execute();
      return reply.status(204).send(null);
    },
  );
  r.delete(
    "/sla-policies/:id",
    { config: custom, schema: { params: idParam } },
    async (req, reply) => {
      const row = await loadPolicy(req, req.params.id);
      await db
        .deleteFrom("track_sla_policy")
        .where("id", "=", row.id)
        .execute();
      return reply.status(204).send(null);
    },
  );
}
