// The self-service portal: what customers can ask for, the request form,
// their requests (and their organization's), sign-up and invitations.
// Every route here is open to customers; rights still come from can().
import {
  AppError,
  getSetting,
  requireUser,
  setSetting,
  SYSTEM_ADMIN,
  type AppContext,
  type AuthUser,
  type CoreDb,
} from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import { issueTarget, PORTAL_SETTING, portalSettings } from "../access.js";
import type { TrackContext } from "../context.js";
import type { IssueService } from "../issues.js";
import { toRequestType } from "./request-types.js";

const portal = { permission: "authenticated" as const, customers: true };
/** Which Nuvenna space is the knowledge base of a project: project key → space key. */
const KNOWLEDGE_SETTING = "track.knowledge";
const knowledgeSpaces = z.record(z.string(), z.string());

export async function portalRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
  app: AppContext,
  issues: IssueService,
): Promise<void> {
  const { db, access } = ctx;
  const core = db as unknown as Kysely<CoreDb>;
  const r = scope.withTypeProvider<ZodTypeProvider>();

  /** Request types in projects where the user may create tickets. */
  async function offered(user: AuthUser) {
    const types = await db
      .selectFrom("track_request_type as t")
      .innerJoin("track_project as p", "p.id", "t.project_id")
      .selectAll("t")
      .select(["p.key as project_key", "p.name as project_name"])
      .where("p.archived", "=", false)
      .orderBy("p.name")
      .orderBy("t.position")
      .execute();
    const allowed = new Map<string, boolean>();
    const out: typeof types = [];
    for (const t of types) {
      if (!allowed.has(t.project_id))
        allowed.set(
          t.project_id,
          await access.can(user, "issue.create", { projectId: t.project_id }),
        );
      if (allowed.get(t.project_id)) out.push(t);
    }
    return out;
  }

  /** The visible fields of a request type's portal form, in order. */
  async function form(layoutId: string) {
    const items = await db
      .selectFrom("track_field_layout_item as i")
      .innerJoin("track_field as f", "f.id", "i.field_id")
      .select([
        "f.id",
        "f.key",
        "f.name",
        "f.type",
        "f.is_system",
        "i.required",
      ])
      .where("i.layout_id", "=", layoutId)
      .where("i.operation", "=", "portal")
      .where("i.hidden", "=", false)
      .orderBy("i.position")
      .execute();
    const options = items.length
      ? await db
          .selectFrom("track_field_option")
          .selectAll()
          .where(
            "field_id",
            "in",
            items.map((i) => i.id),
          )
          .where("disabled", "=", false)
          .orderBy("position")
          .execute()
      : [];
    return items.map((i) => ({
      key: i.key,
      name: i.name,
      type: i.type,
      system: Boolean(i.is_system),
      required: Boolean(i.required),
      options: options
        .filter((o) => o.field_id === i.id)
        .map((o) => ({ id: o.id, parentId: o.parent_id, value: o.value })),
    }));
  }

  const requestTypeOut = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    icon: z.string(),
    groupName: z.string(),
  });

  r.get(
    "/portal/home",
    {
      config: portal,
      schema: {
        response: {
          200: z.array(
            z.object({
              key: z.string(),
              name: z.string(),
              requestTypes: z.array(requestTypeOut),
            }),
          ),
        },
      },
    },
    async (req) => {
      const types = await offered(requireUser(req));
      const projects = new Map<
        string,
        {
          key: string;
          name: string;
          requestTypes: z.infer<typeof requestTypeOut>[];
        }
      >();
      for (const t of types) {
        if (!projects.has(t.project_key))
          projects.set(t.project_key, {
            key: t.project_key,
            name: t.project_name,
            requestTypes: [],
          });
        const { id, name, description, icon, groupName } = toRequestType(t);
        projects
          .get(t.project_key)!
          .requestTypes.push({ id, name, description, icon, groupName });
      }
      return [...projects.values()];
    },
  );

  const fieldOut = z.object({
    key: z.string(),
    name: z.string(),
    type: z.string(),
    system: z.boolean(),
    required: z.boolean(),
    options: z.array(
      z.object({
        id: z.string(),
        parentId: z.string().nullable(),
        value: z.string(),
      }),
    ),
  });

  async function projectFor(user: AuthUser | null, key: string) {
    const project = await db
      .selectFrom("track_project")
      .select(["id", "key"])
      .where("key", "=", key.toUpperCase())
      .executeTakeFirst();
    if (
      !project ||
      !(await access.can(user, "project.browse", { projectId: project.id }))
    )
      throw new AppError(404, "not_found", "Not found");
    return project;
  }

  async function loadType(user: AuthUser, id: string) {
    const t = (await offered(user)).find((x) => x.id === id);
    if (!t) throw new AppError(404, "not_found", "Not found");
    return t;
  }

  r.get(
    "/portal/request-types/:id",
    {
      config: portal,
      schema: {
        params: z.object({ id: z.string() }),
        response: {
          200: requestTypeOut.extend({
            projectKey: z.string(),
            projectName: z.string(),
            fields: z.array(fieldOut),
            /** Space to search for answers before sending; null when none. */
            knowledgeSpace: z.string().nullable(),
          }),
        },
      },
    },
    async (req) => {
      const t = await loadType(requireUser(req), req.params.id);
      const { id, name, description, icon, groupName } = toRequestType(t);
      return {
        id,
        name,
        description,
        icon,
        groupName,
        projectKey: t.project_key,
        projectName: t.project_name,
        fields: await form(t.field_layout_id),
        knowledgeSpace:
          (await getSetting(core, KNOWLEDGE_SETTING, knowledgeSpaces))[
            t.project_key
          ] ?? null,
      };
    },
  );

  r.post(
    "/portal/requests",
    {
      config: portal,
      schema: {
        body: z.object({
          requestTypeId: z.string(),
          fields: z.record(z.string(), z.unknown()),
        }),
        response: { 201: z.object({ key: z.string() }) },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const t = await loadType(user, req.body.requestTypeId);
      // Only what the form asks for; the request type fixes the rest.
      const asked = new Set((await form(t.field_layout_id)).map((f) => f.key));
      asked.add("summary");
      const given = Object.fromEntries(
        Object.entries(req.body.fields).filter(([k]) => asked.has(k)),
      );
      const made = await issues.create(
        user,
        t.project_key,
        t.issue_type_id,
        { ...JSON.parse(t.defaults_json), ...given },
        { requestTypeId: t.id },
      );
      return reply.status(201).send({ key: made.key });
    },
  );

  const requestOut = z.object({
    key: z.string(),
    summary: z.string(),
    statusId: z.string(),
    requestType: z.string().nullable(),
    reporterId: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  });

  r.get(
    "/portal/requests",
    {
      config: portal,
      schema: {
        querystring: z.object({
          /** "organization": also requests of colleagues. */
          scope: z.enum(["mine", "organization"]).default("mine"),
          q: z.string().max(200).default(""),
        }),
        response: { 200: z.array(requestOut) },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const reporters = new Set([user.id]);
      if (req.query.scope === "organization")
        for (const m of await db
          .selectFrom("track_organization_member as a")
          .innerJoin(
            "track_organization_member as b",
            "a.organization_id",
            "b.organization_id",
          )
          .select("b.user_id")
          .where("a.user_id", "=", user.id)
          .execute())
          reporters.add(m.user_id);
      let q = db
        .selectFrom("track_issue as i")
        .leftJoin("track_request_type as t", "t.id", "i.request_type_id")
        .selectAll("i")
        .select("t.name as request_type")
        .where("i.reporter_id", "in", [...reporters]);
      const text = req.query.q.trim();
      if (text)
        q = q.where("i.summary", "like", `%${text.replace(/[%_\\]/g, "")}%`);
      // ponytail: the 200 most recent requests; the portal has no paging yet.
      const rows = await q.orderBy("i.updated_at", "desc").limit(200).execute();
      const out: z.infer<typeof requestOut>[] = [];
      for (const i of rows)
        if (await access.can(user, "project.browse", issueTarget(i)))
          out.push({
            key: i.key,
            summary: i.summary,
            statusId: i.status_id,
            requestType: i.request_type,
            reporterId: i.reporter_id,
            createdAt: i.created_at.toISOString(),
            updatedAt: i.updated_at.toISOString(),
          });
      return out;
    },
  );

  // --- Knowledge base ------------------------------------------------------------------

  r.get(
    "/projects/:key/knowledge-space",
    {
      config: { permission: "custom" as const },
      schema: {
        params: z.object({ key: z.string().max(10) }),
        response: { 200: z.object({ spaceKey: z.string().nullable() }) },
      },
    },
    async (req) => {
      const project = await projectFor(req.user, req.params.key);
      return {
        spaceKey:
          (await getSetting(core, KNOWLEDGE_SETTING, knowledgeSpaces))[
            project.key
          ] ?? null,
      };
    },
  );

  r.put(
    "/projects/:key/knowledge-space",
    {
      config: { permission: "custom" as const },
      schema: {
        params: z.object({ key: z.string().max(10) }),
        body: z.object({
          spaceKey: z
            .string()
            .regex(/^[A-Z][A-Z0-9]{1,19}$/)
            .nullable(),
        }),
        response: { 200: z.object({ spaceKey: z.string().nullable() }) },
      },
    },
    async (req) => {
      const user = requireUser(req);
      const project = await projectFor(user, req.params.key);
      await access.require(user, "project.administer", {
        projectId: project.id,
      });
      const all = await getSetting(core, KNOWLEDGE_SETTING, knowledgeSpaces);
      if (req.body.spaceKey) all[project.key] = req.body.spaceKey;
      else delete all[project.key];
      await setSetting(core, KNOWLEDGE_SETTING, all);
      return { spaceKey: req.body.spaceKey };
    },
  );

  // --- Sign-up, invitations, settings -------------------------------------------------

  r.get(
    "/portal/settings",
    {
      config: { permission: "public" as const, customers: true },
      schema: { response: { 200: z.object({ signup: z.boolean() }) } },
    },
    async () => ({
      signup: (await getSetting(core, PORTAL_SETTING, portalSettings)).signup,
    }),
  );

  r.put(
    "/portal/settings",
    {
      config: { permission: SYSTEM_ADMIN },
      schema: {
        body: portalSettings,
        response: { 200: portalSettings },
      },
    },
    async (req) => {
      await setSetting(core, PORTAL_SETTING, req.body);
      return req.body;
    },
  );

  r.get(
    "/admin/portal-settings",
    {
      config: { permission: SYSTEM_ADMIN },
      schema: { response: { 200: portalSettings } },
    },
    () => getSetting(core, PORTAL_SETTING, portalSettings),
  );

  r.post(
    "/portal/signup",
    {
      config: {
        permission: "public" as const,
        customers: true,
        rateLimit: { max: 5, timeWindow: "1 minute" },
      },
      schema: {
        body: z.object({
          email: z.email().max(320),
          displayName: z.string().trim().min(1).max(200),
          password: z.string().min(10).max(200),
          locale: z.string().min(2).max(10).default("en"),
        }),
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    async (req, reply) => {
      if (!(await getSetting(core, PORTAL_SETTING, portalSettings)).signup)
        throw new AppError(
          403,
          "forbidden",
          "Sign-up is closed. Ask for an invitation.",
        );
      const id = await app.accounts.create({ ...req.body, kind: "customer" });
      await app.accounts.signIn(reply, id);
      return reply.status(201).send({ id });
    },
  );

  r.post(
    "/projects/:key/customers/invite",
    {
      config: { permission: "custom" as const },
      schema: {
        params: z.object({ key: z.string().max(10) }),
        body: z.object({
          email: z.email().max(320),
          displayName: z.string().trim().min(1).max(200),
          locale: z.string().min(2).max(10).default("de"),
        }),
        response: { 201: z.object({ id: z.string(), created: z.boolean() }) },
      },
    },
    async (req, reply) => {
      const actor = requireUser(req);
      const project = await ctx.project(
        actor,
        req.params.key,
        "project.administer",
      );
      const existing = await db
        .selectFrom("core_user")
        .select(["id", "kind"])
        .where("email", "=", req.body.email.trim().toLowerCase())
        .executeTakeFirst();
      if (existing && existing.kind !== "customer")
        throw new AppError(
          409,
          "conflict",
          "This address belongs to a staff account",
        );
      const id =
        existing?.id ??
        (await app.accounts.create({
          ...req.body,
          kind: "customer",
          invitedBy: actor.displayName,
        }));
      const already = await db
        .selectFrom("track_project_customer")
        .select("project_id")
        .where("project_id", "=", project.id)
        .where("principal_type", "=", "user")
        .where("principal_id", "=", id)
        .executeTakeFirst();
      if (!already)
        await db
          .insertInto("track_project_customer")
          .values({
            project_id: project.id,
            principal_type: "user",
            principal_id: id,
          })
          .execute();
      return reply.status(201).send({ id, created: !existing });
    },
  );
}
