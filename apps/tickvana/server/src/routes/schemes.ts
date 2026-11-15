// Who may do what: project roles, permission schemes, notification schemes
// (system administrators) and the security levels of a project (its
// administrators). Projects pick their schemes in PATCH /projects/:key.
import { AppError, requireUser, SYSTEM_ADMIN, uuidv7 } from "@tvn/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { TrackContext } from "../context.js";
import { PROJECT_PERMISSIONS } from "../db/migrations/0002_seed.js";

const name = z.string().trim().min(1).max(200);
const idParam = z.object({ id: z.string() });
const notFound = () => new AppError(404, "not_found", "Not found");
const inUse = (what: string) =>
  new AppError(409, "conflict", `Still used by ${what}`);

const GRANTEES = [
  "role",
  "group",
  "user",
  "anyone",
  "logged_in",
  "reporter",
  "assignee",
  "customer",
] as const;
/** Grantee types that name someone and so need an id. */
const NAMED = new Set(["role", "group", "user"]);
const RECIPIENTS = [
  "assignee",
  "reporter",
  "watchers",
  "project_lead",
  "role",
  "group",
  "user",
] as const;
export const NOTIFIED_EVENTS = [
  "issue.created",
  "issue.updated",
  "issue.transitioned",
  "issue.commented",
  "issue.assigned",
  "issue.deleted",
] as const;

const grant = z.object({
  permission: z.enum(PROJECT_PERMISSIONS),
  granteeType: z.enum(GRANTEES),
  granteeId: z.string().nullable().default(null),
});
const rule = z.object({
  eventType: z.enum(NOTIFIED_EVENTS),
  recipientType: z.enum(RECIPIENTS),
  recipientId: z.string().nullable().default(null),
});
const member = z.object({
  granteeType: z.enum(GRANTEES),
  granteeId: z.string().nullable().default(null),
});
const withId = <T extends z.ZodRawShape>(s: z.ZodObject<T>) =>
  s.extend({ id: z.string() });
const needsId = (type: string, id: string | null) => {
  if (NAMED.has(type) !== (id !== null))
    throw new AppError(
      400,
      "validation",
      NAMED.has(type) ? `${type} needs an id` : `${type} takes no id`,
    );
};

export async function schemeRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
): Promise<void> {
  const { db } = ctx;
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const admin = { permission: SYSTEM_ADMIN };
  const custom = { permission: "custom" as const };

  /** The named principal must exist, so a grant cannot point into nothing. */
  async function checkPrincipal(type: string, id: string | null) {
    needsId(type, id);
    if (id === null) return;
    const table =
      type === "role"
        ? "track_project_role"
        : type === "group"
          ? "core_group"
          : "core_user";
    const found = await db
      .selectFrom(table as "core_group")
      .select("id")
      .where("id", "=", id)
      .executeTakeFirst();
    if (!found) throw new AppError(400, "validation", `Unknown ${type}`);
  }

  // --- Roles ------------------------------------------------------------------------

  const roleOut = z.object({ id: z.string(), name: z.string() });
  r.get(
    "/admin/roles",
    { config: admin, schema: { response: { 200: z.array(roleOut) } } },
    () =>
      db.selectFrom("track_project_role").selectAll().orderBy("name").execute(),
  );
  r.post(
    "/admin/roles",
    {
      config: admin,
      schema: { body: z.object({ name }), response: { 201: roleOut } },
    },
    async (req, reply) => {
      const row = { id: uuidv7(), name: req.body.name };
      await db.insertInto("track_project_role").values(row).execute();
      return reply.status(201).send(row);
    },
  );
  r.patch(
    "/admin/roles/:id",
    {
      config: admin,
      schema: {
        params: idParam,
        body: z.object({ name }),
        response: { 200: roleOut },
      },
    },
    async (req) => {
      const res = await db
        .updateTable("track_project_role")
        .set({ name: req.body.name })
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (res.numUpdatedRows === 0n) throw notFound();
      return { id: req.params.id, name: req.body.name };
    },
  );
  r.delete(
    "/admin/roles/:id",
    { config: admin, schema: { params: idParam } },
    async (req, reply) => {
      const { id } = req.params;
      const d = await ctx.defaults();
      if (Object.values(d.roles).includes(id))
        throw inUse("new projects as a default role");
      const used =
        (await db
          .selectFrom("track_project_role_member")
          .select("role_id")
          .where("role_id", "=", id)
          .executeTakeFirst()) ??
        (await db
          .selectFrom("track_permission_grant")
          .select("id")
          .where("grantee_type", "=", "role")
          .where("grantee_id", "=", id)
          .executeTakeFirst());
      if (used) throw inUse("members or grants");
      const res = await db
        .deleteFrom("track_project_role")
        .where("id", "=", id)
        .executeTakeFirst();
      if (res.numDeletedRows === 0n) throw notFound();
      return reply.status(204).send(null);
    },
  );

  // --- Permission and notification schemes ------------------------------------------

  const schemes = [
    {
      path: "permission-schemes",
      table: "track_permission_scheme",
      entries: "track_permission_grant",
      projectColumn: "permission_scheme_id",
      defaultKey: "permissionSchemeId",
      entry: grant,
      toRow: (e: z.infer<typeof grant>) => ({
        permission: e.permission,
        grantee_type: e.granteeType,
        grantee_id: e.granteeId,
      }),
      fromRow: (x: Record<string, unknown>) => ({
        id: x.id as string,
        permission: x.permission as (typeof PROJECT_PERMISSIONS)[number],
        granteeType: x.grantee_type as (typeof GRANTEES)[number],
        granteeId: x.grantee_id as string | null,
      }),
      principal: (e: z.infer<typeof grant>) => [e.granteeType, e.granteeId],
    },
    {
      path: "notification-schemes",
      table: "track_notification_scheme",
      entries: "track_notification_rule",
      projectColumn: "notification_scheme_id",
      defaultKey: "notificationSchemeId",
      entry: rule,
      toRow: (e: z.infer<typeof rule>) => ({
        event_type: e.eventType,
        recipient_type: e.recipientType,
        recipient_id: e.recipientId,
      }),
      fromRow: (x: Record<string, unknown>) => ({
        id: x.id as string,
        eventType: x.event_type as (typeof NOTIFIED_EVENTS)[number],
        recipientType: x.recipient_type as (typeof RECIPIENTS)[number],
        recipientId: x.recipient_id as string | null,
      }),
      principal: (e: z.infer<typeof rule>) => [e.recipientType, e.recipientId],
    },
  ] as const;

  for (const s of schemes) {
    // The two scheme kinds share their shape; Kysely sees them through one loose type.
    const q = db as unknown as import("kysely").Kysely<
      Record<string, Record<string, unknown>>
    >;
    const entryOut = withId(s.entry as z.ZodObject<z.ZodRawShape>);
    const schemeOut = z.object({
      id: z.string(),
      name: z.string(),
      projects: z.array(z.string()),
      entries: z.array(entryOut),
    });
    const load = async (id: string) => {
      const scheme = await q
        .selectFrom(s.table)
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!scheme) throw notFound();
      const [entries, projects] = await Promise.all([
        q
          .selectFrom(s.entries)
          .selectAll()
          .where("scheme_id", "=", id)
          .orderBy("id")
          .execute(),
        db
          .selectFrom("track_project")
          .select("key")
          .where(s.projectColumn, "=", id)
          .orderBy("key")
          .execute(),
      ]);
      return {
        id,
        name: scheme.name as string,
        projects: projects.map((p) => p.key),
        entries: entries.map((e) => s.fromRow(e)) as object[],
      };
    };

    r.get(
      `/admin/${s.path}`,
      { config: admin, schema: { response: { 200: z.array(schemeOut) } } },
      async () => {
        const rows = await q
          .selectFrom(s.table)
          .select("id")
          .orderBy("name")
          .execute();
        return Promise.all(rows.map((x) => load(x.id as string))) as never;
      },
    );
    r.post(
      `/admin/${s.path}`,
      {
        config: admin,
        schema: {
          body: z.object({ name, copyFrom: z.string().optional() }),
          response: { 201: schemeOut },
        },
      },
      async (req, reply) => {
        const id = uuidv7();
        const source = req.body.copyFrom ? await load(req.body.copyFrom) : null;
        await db.transaction().execute(async (trx) => {
          const t = trx as unknown as typeof q;
          await t
            .insertInto(s.table)
            .values({ id, name: req.body.name })
            .execute();
          if (source?.entries.length)
            await t
              .insertInto(s.entries)
              .values(
                source.entries.map((e) => ({
                  id: uuidv7(),
                  scheme_id: id,
                  ...s.toRow(e as never),
                })),
              )
              .execute();
        });
        return reply.status(201).send((await load(id)) as never);
      },
    );
    r.patch(
      `/admin/${s.path}/:id`,
      {
        config: admin,
        schema: {
          params: idParam,
          body: z.object({ name }),
          response: { 200: schemeOut },
        },
      },
      async (req) => {
        await load(req.params.id);
        await q
          .updateTable(s.table)
          .set({ name: req.body.name })
          .where("id", "=", req.params.id)
          .execute();
        return (await load(req.params.id)) as never;
      },
    );
    r.delete(
      `/admin/${s.path}/:id`,
      { config: admin, schema: { params: idParam } },
      async (req, reply) => {
        const scheme = await load(req.params.id);
        const d = await ctx.defaults();
        if (d[s.defaultKey] === scheme.id) throw inUse("new projects");
        if (scheme.projects.length)
          throw inUse(`projects ${scheme.projects.join(", ")}`);
        await db.transaction().execute(async (trx) => {
          const t = trx as unknown as typeof q;
          await t
            .deleteFrom(s.entries)
            .where("scheme_id", "=", scheme.id)
            .execute();
          await t.deleteFrom(s.table).where("id", "=", scheme.id).execute();
        });
        return reply.status(204).send(null);
      },
    );
    r.post(
      `/admin/${s.path}/:id/entries`,
      {
        config: admin,
        schema: { params: idParam, body: s.entry, response: { 201: entryOut } },
      },
      async (req, reply) => {
        await load(req.params.id);
        const body = req.body as never;
        const [type, who] = s.principal(body);
        await checkPrincipal(type!, who ?? null);
        const row = {
          id: uuidv7(),
          scheme_id: req.params.id,
          ...s.toRow(body),
        };
        await q.insertInto(s.entries).values(row).execute();
        return reply.status(201).send(s.fromRow(row) as never);
      },
    );
    r.delete(
      `/admin/${s.path}/:id/entries/:entryId`,
      {
        config: admin,
        schema: { params: idParam.extend({ entryId: z.string() }) },
      },
      async (req, reply) => {
        const res = await q
          .deleteFrom(s.entries)
          .where("id", "=", req.params.entryId)
          .where("scheme_id", "=", req.params.id)
          .executeTakeFirst();
        if (res.numDeletedRows === 0n) throw notFound();
        return reply.status(204).send(null);
      },
    );
  }

  // --- Security levels of a project ---------------------------------------------------

  const levelOut = z.object({
    id: z.string(),
    name: z.string(),
    members: z.array(withId(member)),
  });
  const project = (req: FastifyRequest<{ Params: { key: string } }>) =>
    ctx.project(requireUser(req), req.params.key, "project.administer");
  const levelOf = async (req: FastifyRequest, id: string) => {
    const level = await db
      .selectFrom("track_security_level as l")
      .innerJoin("track_project as p", "p.id", "l.project_id")
      .select(["l.id", "l.name", "p.key"])
      .where("l.id", "=", id)
      .executeTakeFirst();
    if (!level) throw notFound();
    await ctx.project(requireUser(req), level.key, "project.administer");
    return level;
  };
  const listLevels = async (projectId: string) => {
    const levels = await db
      .selectFrom("track_security_level")
      .selectAll()
      .where("project_id", "=", projectId)
      .orderBy("name")
      .execute();
    const members = levels.length
      ? await db
          .selectFrom("track_security_level_member")
          .selectAll()
          .where(
            "level_id",
            "in",
            levels.map((l) => l.id),
          )
          .orderBy("id")
          .execute()
      : [];
    return levels.map((l) => ({
      id: l.id,
      name: l.name,
      members: members
        .filter((m) => m.level_id === l.id)
        .map((m) => ({
          id: m.id,
          granteeType: m.grantee_type,
          granteeId: m.grantee_id,
        })),
    }));
  };

  r.get(
    "/projects/:key/security-levels",
    {
      config: custom,
      schema: {
        params: z.object({ key: z.string().max(10) }),
        response: { 200: z.array(levelOut) },
      },
    },
    async (req) => listLevels((await project(req)).id),
  );
  r.post(
    "/projects/:key/security-levels",
    {
      config: custom,
      schema: {
        params: z.object({ key: z.string().max(10) }),
        body: z.object({ name }),
        response: { 201: levelOut },
      },
    },
    async (req, reply) => {
      const p = await project(req);
      const row = { id: uuidv7(), project_id: p.id, name: req.body.name };
      await db.insertInto("track_security_level").values(row).execute();
      return reply
        .status(201)
        .send({ id: row.id, name: row.name, members: [] });
    },
  );
  r.delete(
    "/security-levels/:id",
    { config: custom, schema: { params: idParam } },
    async (req, reply) => {
      const level = await levelOf(req, req.params.id);
      const used = await db
        .selectFrom("track_issue")
        .select("id")
        .where("security_level_id", "=", level.id)
        .executeTakeFirst();
      if (used) throw inUse("tickets");
      await db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("track_security_level_member")
          .where("level_id", "=", level.id)
          .execute();
        await trx
          .deleteFrom("track_security_level")
          .where("id", "=", level.id)
          .execute();
      });
      return reply.status(204).send(null);
    },
  );
  r.post(
    "/security-levels/:id/members",
    {
      config: custom,
      schema: {
        params: idParam,
        body: member,
        response: { 201: withId(member) },
      },
    },
    async (req, reply) => {
      const level = await levelOf(req, req.params.id);
      await checkPrincipal(req.body.granteeType, req.body.granteeId);
      const row = {
        id: uuidv7(),
        level_id: level.id,
        grantee_type: req.body.granteeType,
        grantee_id: req.body.granteeId,
      };
      await db.insertInto("track_security_level_member").values(row).execute();
      return reply.status(201).send({ id: row.id, ...req.body });
    },
  );
  r.delete(
    "/security-levels/:id/members/:memberId",
    {
      config: custom,
      schema: { params: idParam.extend({ memberId: z.string() }) },
    },
    async (req, reply) => {
      const level = await levelOf(req, req.params.id);
      const res = await db
        .deleteFrom("track_security_level_member")
        .where("id", "=", req.params.memberId)
        .where("level_id", "=", level.id)
        .executeTakeFirst();
      if (res.numDeletedRows === 0n) throw notFound();
      return reply.status(204).send(null);
    },
  );
}
