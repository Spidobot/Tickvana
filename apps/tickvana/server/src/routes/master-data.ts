// Master data for system administrators: issue types, statuses, priorities,
// resolutions and link types. Reading goes through /meta and /link-types.
// Entries still in use cannot be deleted; rename them instead.
import { AppError, SYSTEM_ADMIN, uuidv7 } from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { TrackContext } from "../context.js";

const name = z.string().trim().min(1).max(60);

const KINDS = {
  "issue-types": {
    table: "track_issue_type",
    body: z.object({
      name,
      icon: z.string().regex(/^[a-z0-9-]{1,40}$/),
      /** 1 epic, 0 standard, -1 sub-task */
      level: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    }),
    uses: [
      ["track_issue", "type_id"],
      ["track_project_issue_type", "issue_type_id"],
    ],
  },
  statuses: {
    table: "track_status",
    body: z.object({ name, category: z.enum(["todo", "in_progress", "done"]) }),
    uses: [
      ["track_issue", "status_id"],
      ["track_workflow_status", "status_id"],
    ],
  },
  priorities: {
    table: "track_priority",
    body: z.object({
      name,
      color: z.string().regex(/^#[0-9a-f]{6}$/i),
      position: z.number().int().min(0).max(1000),
    }),
    uses: [["track_issue", "priority_id"]],
  },
  resolutions: {
    table: "track_resolution",
    body: z.object({ name }),
    uses: [["track_issue", "resolution_id"]],
  },
  "link-types": {
    table: "track_link_type",
    body: z.object({ name, outward: name, inward: name }),
    uses: [["track_issue_link", "type_id"]],
  },
} as const;

export async function masterDataRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
): Promise<void> {
  // The five tables share id + name; the rest is checked by each kind's schema.
  const db = ctx.db as unknown as Kysely<
    Record<string, { id: string; name: string } & Record<string, unknown>>
  >;
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const config = { permission: SYSTEM_ADMIN };
  const idParam = z.object({ id: z.string() });

  for (const [kind, def] of Object.entries(KINDS)) {
    const out = def.body.extend({ id: z.string() });
    const load = async (id: string) => {
      const row = await db
        .selectFrom(def.table)
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) throw new AppError(404, "not_found", "Not found");
      return row as { id: string; name: string };
    };
    const uniqueName = async (value: string, except?: string) => {
      const rows = await db
        .selectFrom(def.table)
        .select(["id", "name"])
        .execute();
      if (
        rows.some(
          (x) =>
            x.id !== except && x.name.toLowerCase() === value.toLowerCase(),
        )
      )
        throw new AppError(409, "conflict", "This name is taken");
    };

    r.post(
      `/admin/${kind}`,
      { config, schema: { body: def.body, response: { 201: out } } },
      async (req, reply) => {
        const body = req.body as z.infer<typeof def.body>;
        await uniqueName(body.name);
        const row = { id: uuidv7(), ...body };
        await db.insertInto(def.table).values(row).execute();
        return reply.status(201).send(row);
      },
    );

    r.patch(
      `/admin/${kind}/:id`,
      {
        config,
        schema: {
          params: idParam,
          body: def.body.partial(),
          response: { 200: out },
        },
      },
      async (req) => {
        const row = await load(req.params.id);
        const body = req.body as Partial<z.infer<typeof def.body>>;
        if (body.name) await uniqueName(body.name, row.id);
        if (Object.keys(body).length)
          await db
            .updateTable(def.table)
            .set(body)
            .where("id", "=", row.id)
            .execute();
        return { ...row, ...body } as never;
      },
    );

    r.delete(
      `/admin/${kind}/:id`,
      { config, schema: { params: idParam } },
      async (req, reply) => {
        const row = await load(req.params.id);
        const defaults = await ctx.defaults();
        let used =
          def.table === "track_priority" && defaults.priorityId === row.id;
        for (const [table, column] of def.uses)
          used ||= !!(await db
            .selectFrom(table)
            .select(column)
            .where(column, "=", row.id)
            .limit(1)
            .executeTakeFirst());
        if (used)
          throw new AppError(
            409,
            "conflict",
            "Still in use. Rename it or move its tickets first.",
          );
        await db.deleteFrom(def.table).where("id", "=", row.id).execute();
        return reply.status(204).send(null);
      },
    );
  }
}

export type MasterDataKind = keyof typeof KINDS;
