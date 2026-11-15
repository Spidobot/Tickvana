// Organizations of customers (system administrators) and who is a customer
// of a project (its administrators).
import { AppError, requireUser, SYSTEM_ADMIN, uuidv7 } from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { TrackContext } from "../context.js";

export async function customerRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
): Promise<void> {
  const { db } = ctx;
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const admin = { permission: SYSTEM_ADMIN };
  const staff = { permission: "authenticated" as const };
  const custom = { permission: "custom" as const };
  const idParam = z.object({ id: z.string() });
  const name = z.string().trim().min(1).max(200);
  const taken = async (value: string, except?: string) => {
    const rows = await db
      .selectFrom("track_organization")
      .select(["id", "name"])
      .execute();
    if (
      rows.some(
        (o) => o.id !== except && o.name.toLowerCase() === value.toLowerCase(),
      )
    )
      throw new AppError(409, "conflict", "This name is taken");
  };
  const user = z.object({
    id: z.string(),
    displayName: z.string(),
    email: z.string(),
  });

  r.get(
    "/organizations",
    {
      config: staff,
      schema: {
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              members: z.array(user),
            }),
          ),
        },
      },
    },
    async () => {
      const orgs = await db
        .selectFrom("track_organization")
        .selectAll()
        .orderBy("name")
        .execute();
      const members = await db
        .selectFrom("track_organization_member as m")
        .innerJoin("core_user as u", "u.id", "m.user_id")
        .select(["m.organization_id", "u.id", "u.display_name", "u.email"])
        .orderBy("u.display_name")
        .execute();
      return orgs.map((o) => ({
        id: o.id,
        name: o.name,
        members: members
          .filter((m) => m.organization_id === o.id)
          .map((m) => ({
            id: m.id,
            displayName: m.display_name,
            email: m.email,
          })),
      }));
    },
  );
  r.post(
    "/admin/organizations",
    {
      config: admin,
      schema: {
        body: z.object({ name }),
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    async (req, reply) => {
      await taken(req.body.name);
      const id = uuidv7();
      await db
        .insertInto("track_organization")
        .values({ id, name: req.body.name })
        .execute();
      return reply.status(201).send({ id });
    },
  );
  r.patch(
    "/admin/organizations/:id",
    { config: admin, schema: { params: idParam, body: z.object({ name }) } },
    async (req, reply) => {
      await taken(req.body.name, req.params.id);
      const res = await db
        .updateTable("track_organization")
        .set({ name: req.body.name })
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (res.numUpdatedRows === 0n)
        throw new AppError(404, "not_found", "Not found");
      return reply.status(204).send(null);
    },
  );
  r.delete(
    "/admin/organizations/:id",
    { config: admin, schema: { params: idParam } },
    async (req, reply) => {
      await db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("track_project_customer")
          .where("principal_type", "=", "organization")
          .where("principal_id", "=", req.params.id)
          .execute();
        await trx
          .deleteFrom("track_organization")
          .where("id", "=", req.params.id)
          .execute();
      });
      return reply.status(204).send(null);
    },
  );
  const memberParams = idParam.extend({ userId: z.string() });
  r.put(
    "/admin/organizations/:id/members/:userId",
    { config: admin, schema: { params: memberParams } },
    async (req, reply) => {
      const [org, u] = await Promise.all([
        db
          .selectFrom("track_organization")
          .select("id")
          .where("id", "=", req.params.id)
          .executeTakeFirst(),
        db
          .selectFrom("core_user")
          .select("id")
          .where("id", "=", req.params.userId)
          .executeTakeFirst(),
      ]);
      if (!org || !u) throw new AppError(404, "not_found", "Not found");
      const known = await db
        .selectFrom("track_organization_member")
        .select("user_id")
        .where("organization_id", "=", org.id)
        .where("user_id", "=", u.id)
        .executeTakeFirst();
      if (!known)
        await db
          .insertInto("track_organization_member")
          .values({ organization_id: org.id, user_id: u.id })
          .execute();
      return reply.status(204).send(null);
    },
  );
  r.delete(
    "/admin/organizations/:id/members/:userId",
    { config: admin, schema: { params: memberParams } },
    async (req, reply) => {
      await db
        .deleteFrom("track_organization_member")
        .where("organization_id", "=", req.params.id)
        .where("user_id", "=", req.params.userId)
        .execute();
      return reply.status(204).send(null);
    },
  );

  // --- Customers of a project ---------------------------------------------------------

  const keyParam = z.object({ key: z.string().max(10) });
  const principal = z.object({
    principalType: z.enum(["user", "organization"]),
    principalId: z.string(),
  });
  r.get(
    "/projects/:key/customers",
    {
      config: custom,
      schema: {
        params: keyParam,
        response: { 200: z.array(principal.extend({ name: z.string() })) },
      },
    },
    async (req) => {
      const project = await ctx.project(
        requireUser(req),
        req.params.key,
        "project.administer",
      );
      const rows = await db
        .selectFrom("track_project_customer")
        .selectAll()
        .where("project_id", "=", project.id)
        .execute();
      const [users, orgs] = await Promise.all([
        db
          .selectFrom("core_user")
          .select(["id", "display_name", "email"])
          .execute(),
        db.selectFrom("track_organization").selectAll().execute(),
      ]);
      return rows
        .map((c) => ({
          principalType: c.principal_type,
          principalId: c.principal_id,
          name:
            c.principal_type === "user"
              ? (() => {
                  const u = users.find((x) => x.id === c.principal_id);
                  return u ? `${u.display_name} <${u.email}>` : c.principal_id;
                })()
              : (orgs.find((o) => o.id === c.principal_id)?.name ??
                c.principal_id),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  );
  r.put(
    "/projects/:key/customers",
    { config: custom, schema: { params: keyParam, body: principal } },
    async (req, reply) => {
      const project = await ctx.project(
        requireUser(req),
        req.params.key,
        "project.administer",
      );
      const { principalType, principalId } = req.body;
      const exists =
        principalType === "user"
          ? await db
              .selectFrom("core_user")
              .select("id")
              .where("id", "=", principalId)
              .executeTakeFirst()
          : await db
              .selectFrom("track_organization")
              .select("id")
              .where("id", "=", principalId)
              .executeTakeFirst();
      if (!exists)
        throw new AppError(400, "validation", `Unknown ${principalType}`);
      const known = await db
        .selectFrom("track_project_customer")
        .select("project_id")
        .where("project_id", "=", project.id)
        .where("principal_type", "=", principalType)
        .where("principal_id", "=", principalId)
        .executeTakeFirst();
      if (!known)
        await db
          .insertInto("track_project_customer")
          .values({
            project_id: project.id,
            principal_type: principalType,
            principal_id: principalId,
          })
          .execute();
      return reply.status(204).send(null);
    },
  );
  r.delete(
    "/projects/:key/customers",
    { config: custom, schema: { params: keyParam, body: principal } },
    async (req, reply) => {
      const project = await ctx.project(
        requireUser(req),
        req.params.key,
        "project.administer",
      );
      await db
        .deleteFrom("track_project_customer")
        .where("project_id", "=", project.id)
        .where("principal_type", "=", req.body.principalType)
        .where("principal_id", "=", req.body.principalId)
        .execute();
      return reply.status(204).send(null);
    },
  );
}
