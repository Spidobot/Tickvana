// Request types of a service project: what customers can ask for in the
// portal. Each has its own form (the "portal" part of a field layout), a
// group on the portal start page, and fixed values for fields the form
// does not ask for.
import { AppError, requireUser, uuidv7 } from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { TrackContext } from "../context.js";
import type { TrackDb } from "../db/schema.js";

const body = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).default(""),
  icon: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/)
    .default("message-square"),
  groupName: z.string().trim().max(100).default(""),
  issueTypeId: z.string(),
  fieldLayoutId: z.string(),
  /** Field key → value, set on every request of this type. */
  defaults: z.record(z.string(), z.unknown()).default({}),
});
const out = body.extend({ id: z.string(), position: z.number() });
type Row = TrackDb["track_request_type"];

export const toRequestType = (r: Row): z.infer<typeof out> => ({
  id: r.id,
  name: r.name,
  description: r.description,
  icon: r.icon,
  groupName: r.group_name,
  issueTypeId: r.issue_type_id,
  fieldLayoutId: r.field_layout_id,
  defaults: JSON.parse(r.defaults_json),
  position: r.position,
});

export async function requestTypeRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
): Promise<void> {
  const { db } = ctx;
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const custom = { permission: "custom" as const };
  const keyParam = z.object({ key: z.string().max(10) });
  const idParam = z.object({ id: z.string() });

  /** The type must be used by the project, the layout must exist, defaults must name fields. */
  async function check(projectId: string, b: z.infer<typeof body>) {
    const mapped = await db
      .selectFrom("track_project_issue_type")
      .select("issue_type_id")
      .where("project_id", "=", projectId)
      .where("issue_type_id", "=", b.issueTypeId)
      .executeTakeFirst();
    if (!mapped)
      throw new AppError(
        400,
        "validation",
        "The project does not use this ticket type",
      );
    const layout = await db
      .selectFrom("track_field_layout")
      .select("id")
      .where("id", "=", b.fieldLayoutId)
      .executeTakeFirst();
    if (!layout) throw new AppError(400, "validation", "Unknown field layout");
    const keys = new Set(
      (await db.selectFrom("track_field").select("key").execute()).map(
        (f) => f.key,
      ),
    );
    for (const k of Object.keys(b.defaults))
      if (
        !keys.has(k) ||
        ["status", "type", "resolution", "reporter"].includes(k)
      )
        throw new AppError(
          400,
          "validation",
          `"${k}" cannot have a fixed value`,
        );
  }
  const columns = (b: z.infer<typeof body>) => ({
    name: b.name,
    description: b.description,
    icon: b.icon,
    group_name: b.groupName,
    issue_type_id: b.issueTypeId,
    field_layout_id: b.fieldLayoutId,
    defaults_json: JSON.stringify(b.defaults),
  });
  async function load(req: Parameters<typeof requireUser>[0], id: string) {
    const row = await db
      .selectFrom("track_request_type as t")
      .innerJoin("track_project as p", "p.id", "t.project_id")
      .selectAll("t")
      .select("p.key as project_key")
      .where("t.id", "=", id)
      .executeTakeFirst();
    if (!row) throw new AppError(404, "not_found", "Not found");
    await ctx.project(requireUser(req), row.project_key, "project.administer");
    return row;
  }

  r.get(
    "/projects/:key/request-types",
    {
      config: custom,
      schema: { params: keyParam, response: { 200: z.array(out) } },
    },
    async (req) => {
      const project = await ctx.project(requireUser(req), req.params.key);
      const rows = await db
        .selectFrom("track_request_type")
        .selectAll()
        .where("project_id", "=", project.id)
        .orderBy("position")
        .execute();
      return rows.map(toRequestType);
    },
  );

  r.post(
    "/projects/:key/request-types",
    {
      config: custom,
      schema: { params: keyParam, body, response: { 201: out } },
    },
    async (req, reply) => {
      const project = await ctx.project(
        requireUser(req),
        req.params.key,
        "project.administer",
      );
      await check(project.id, req.body);
      const last = await db
        .selectFrom("track_request_type")
        .select("position")
        .where("project_id", "=", project.id)
        .orderBy("position", "desc")
        .executeTakeFirst();
      const row: Row = {
        id: uuidv7(),
        project_id: project.id,
        position: (last?.position ?? -1) + 1,
        ...columns(req.body),
      };
      await db.insertInto("track_request_type").values(row).execute();
      return reply.status(201).send(toRequestType(row));
    },
  );

  r.put(
    "/request-types/:id",
    {
      config: custom,
      schema: {
        params: idParam,
        body: body.extend({ position: z.number().int().min(0).optional() }),
        response: { 200: out },
      },
    },
    async (req) => {
      const row = await load(req, req.params.id);
      await check(row.project_id, req.body);
      const next = {
        ...columns(req.body),
        position: req.body.position ?? row.position,
      };
      await db
        .updateTable("track_request_type")
        .set(next)
        .where("id", "=", row.id)
        .execute();
      return toRequestType({ ...row, ...next });
    },
  );

  r.delete(
    "/request-types/:id",
    { config: custom, schema: { params: idParam } },
    async (req, reply) => {
      const row = await load(req, req.params.id);
      // Tickets keep their data; their link to the type is cleared (on delete set null).
      await db
        .deleteFrom("track_request_type")
        .where("id", "=", row.id)
        .execute();
      return reply.status(204).send(null);
    },
  );
}
