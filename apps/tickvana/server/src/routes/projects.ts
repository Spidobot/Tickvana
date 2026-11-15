import { AppError, requireUser, uuidv7, SYSTEM_ADMIN } from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { TrackContext } from "../context.js";
import type { TrackDb } from "../db/schema.js";

/** Issue types a new project starts with, by template. All use the default workflow and layout. */
const TEMPLATES: Record<TrackDb["track_project"]["kind"], string[]> = {
  software: ["Epic", "Story", "Task", "Bug", "Sub-task"],
  business: ["Task", "Sub-task"],
  service: ["Task"],
};

const kind = z.enum(["software", "service", "business"]);
const projectSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  kind,
  leadId: z.string(),
  archived: z.boolean(),
  permissionSchemeId: z.string(),
  notificationSchemeId: z.string(),
});
const toProject = (
  p: TrackDb["track_project"],
): z.infer<typeof projectSchema> => ({
  id: p.id,
  key: p.key,
  name: p.name,
  kind: p.kind,
  leadId: p.lead_id,
  archived: p.archived,
  permissionSchemeId: p.permission_scheme_id,
  notificationSchemeId: p.notification_scheme_id,
});

const keyParam = z.object({ key: z.string().max(10) });
const projectKey = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[A-Z][A-Z0-9]{1,9}$/,
    "2 to 10 letters or digits, starting with a letter",
  );

export async function projectRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
): Promise<void> {
  const { db, access } = ctx;
  const r = scope.withTypeProvider<ZodTypeProvider>();
  // Handlers check through ctx.project(): it hides projects the user may not see.
  const custom = { permission: "custom" as const };

  r.get(
    "/projects",
    {
      config: custom,
      schema: {
        querystring: z.object({
          includeArchived: z.stringbool().default(false),
        }),
        response: { 200: z.array(projectSchema) },
      },
    },
    async (req) => {
      const ids = await access.visibleProjectIds(req.user);
      if (ids.length === 0) return [];
      let query = db
        .selectFrom("track_project")
        .selectAll()
        .where("id", "in", ids);
      if (!req.query.includeArchived)
        query = query.where("archived", "=", false);
      return (await query.orderBy("name").execute()).map(toProject);
    },
  );

  r.post(
    "/projects",
    {
      config: { permission: "project.create" },
      schema: {
        body: z.object({
          key: projectKey,
          name: z.string().trim().min(1).max(200),
          kind: kind.default("software"),
          /** Defaults to the person creating the project. */
          leadId: z.string().optional(),
        }),
        response: { 201: projectSchema },
      },
    },
    async (req, reply) => {
      const actor = requireUser(req);
      const d = await ctx.defaults();
      const leadId = req.body.leadId ?? actor.id;
      const project: TrackDb["track_project"] = {
        id: uuidv7(),
        key: req.body.key,
        name: req.body.name,
        kind: req.body.kind,
        lead_id: leadId,
        permission_scheme_id: d.permissionSchemeId,
        notification_scheme_id: d.notificationSchemeId,
        issue_counter: 0,
        archived: false,
        created_at: new Date(),
      };

      await db.transaction().execute(async (trx) => {
        const taken = await trx
          .selectFrom("track_project")
          .select("id")
          .where("key", "=", project.key)
          .executeTakeFirst();
        if (taken)
          throw new AppError(
            409,
            "conflict",
            `Project key "${project.key}" is already in use`,
          );
        const lead = await trx
          .selectFrom("core_user")
          .select("id")
          .where("id", "=", leadId)
          .where("active", "=", true)
          .executeTakeFirst();
        if (!lead)
          throw new AppError(
            400,
            "validation",
            "Project lead must be an active user",
          );

        await trx.insertInto("track_project").values(project).execute();
        const types = await trx
          .selectFrom("track_issue_type")
          .select(["id", "name"])
          .where("name", "in", TEMPLATES[project.kind])
          .execute();
        await trx
          .insertInto("track_project_issue_type")
          .values(
            types.map((t) => ({
              project_id: project.id,
              issue_type_id: t.id,
              workflow_id: d.workflowId,
              field_layout_id: d.fieldLayoutId,
            })),
          )
          .execute();
        // Whoever creates or leads the project can administer it from the start.
        await trx
          .insertInto("track_project_role_member")
          .values(
            [...new Set([actor.id, leadId])].map((id) => ({
              project_id: project.id,
              role_id: d.roles.administrators,
              principal_type: "user" as const,
              principal_id: id,
            })),
          )
          .execute();
        await ctx.emit(trx, {
          type: "project.created",
          actorId: actor.id,
          entityType: "project",
          entityId: project.id,
        });
      });
      return reply.status(201).send(toProject(project));
    },
  );

  const issueTypeSchema = z.object({
    id: z.string(),
    name: z.string(),
    icon: z.string(),
    level: z.number(),
    workflowId: z.string(),
    fieldLayoutId: z.string(),
  });
  const issueTypes = async (projectId: string) =>
    (
      await db
        .selectFrom("track_project_issue_type as pit")
        .innerJoin("track_issue_type as it", "it.id", "pit.issue_type_id")
        .select([
          "it.id",
          "it.name",
          "it.icon",
          "it.level",
          "pit.workflow_id",
          "pit.field_layout_id",
        ])
        .where("pit.project_id", "=", projectId)
        .orderBy("it.level", "desc")
        .orderBy("it.name")
        .execute()
    ).map((t) => ({
      id: t.id,
      name: t.name,
      icon: t.icon,
      level: t.level,
      workflowId: t.workflow_id,
      fieldLayoutId: t.field_layout_id,
    }));

  r.get(
    "/projects/:key",
    {
      config: custom,
      schema: {
        params: keyParam,
        response: {
          200: projectSchema.extend({ issueTypes: z.array(issueTypeSchema) }),
        },
      },
    },
    async (req) => {
      const project = await ctx.project(req.user, req.params.key);
      return {
        ...toProject(project),
        issueTypes: await issueTypes(project.id),
      };
    },
  );

  r.patch(
    "/projects/:key",
    {
      config: custom,
      schema: {
        params: keyParam,
        // No defaults: a default would overwrite fields the caller left out.
        body: z
          .object({
            name: z.string().trim().min(1).max(200),
            leadId: z.string(),
            archived: z.boolean(),
            /** Schemes decide what members may do: system administrators only. */
            permissionSchemeId: z.string(),
            notificationSchemeId: z.string(),
          })
          .partial(),
        response: { 200: projectSchema },
      },
    },
    async (req) => {
      const actor = requireUser(req);
      const project = await ctx.project(
        actor,
        req.params.key,
        "project.administer",
      );
      const {
        name,
        leadId,
        archived,
        permissionSchemeId,
        notificationSchemeId,
      } = req.body;
      if (permissionSchemeId ?? notificationSchemeId) {
        await ctx.permissions.require(actor, SYSTEM_ADMIN);
        for (const [table, id] of [
          ["track_permission_scheme", permissionSchemeId],
          ["track_notification_scheme", notificationSchemeId],
        ] as const) {
          if (
            id !== undefined &&
            !(await db
              .selectFrom(table)
              .select("id")
              .where("id", "=", id)
              .executeTakeFirst())
          )
            throw new AppError(400, "validation", "Unknown scheme");
        }
      }
      await db.transaction().execute(async (trx) => {
        if (leadId) {
          const lead = await trx
            .selectFrom("core_user")
            .select("id")
            .where("id", "=", leadId)
            .where("active", "=", true)
            .executeTakeFirst();
          if (!lead)
            throw new AppError(
              400,
              "validation",
              "Project lead must be an active user",
            );
        }
        await trx
          .updateTable("track_project")
          .set({
            ...(name !== undefined && { name }),
            ...(leadId !== undefined && { lead_id: leadId }),
            ...(archived !== undefined && { archived }),
            ...(permissionSchemeId !== undefined && {
              permission_scheme_id: permissionSchemeId,
            }),
            ...(notificationSchemeId !== undefined && {
              notification_scheme_id: notificationSchemeId,
            }),
          })
          .where("id", "=", project.id)
          .execute();
        const type =
          archived === undefined || archived === project.archived
            ? "project.updated"
            : archived
              ? "project.archived"
              : "project.restored";
        await ctx.emit(trx, {
          type,
          actorId: actor.id,
          entityType: "project",
          entityId: project.id,
        });
      });
      return toProject(
        await db
          .selectFrom("track_project")
          .selectAll()
          .where("id", "=", project.id)
          .executeTakeFirstOrThrow(),
      );
    },
  );

  // --- Issue types of a project -----------------------------------------------------

  const typeParams = keyParam.extend({ typeId: z.string() });

  r.put(
    "/projects/:key/issue-types/:typeId",
    {
      config: custom,
      schema: {
        params: typeParams,
        body: z.object({
          workflowId: z.string().optional(),
          fieldLayoutId: z.string().optional(),
        }),
        response: { 200: z.array(issueTypeSchema) },
      },
    },
    async (req) => {
      const project = await ctx.project(
        req.user,
        req.params.key,
        "project.administer",
      );
      const d = await ctx.defaults();
      const workflowId = req.body.workflowId ?? d.workflowId;
      const fieldLayoutId = req.body.fieldLayoutId ?? d.fieldLayoutId;

      await db.transaction().execute(async (trx) => {
        const [type, workflow, layout] = await Promise.all([
          trx
            .selectFrom("track_issue_type")
            .select("id")
            .where("id", "=", req.params.typeId)
            .executeTakeFirst(),
          trx
            .selectFrom("track_workflow")
            .select("id")
            .where("id", "=", workflowId)
            .executeTakeFirst(),
          trx
            .selectFrom("track_field_layout")
            .select("id")
            .where("id", "=", fieldLayoutId)
            .executeTakeFirst(),
        ]);
        if (!type || !workflow || !layout)
          throw new AppError(
            400,
            "validation",
            "Unknown issue type, workflow or field layout",
          );

        const where = (
          q: ReturnType<typeof trx.selectFrom<"track_project_issue_type">>,
        ) =>
          q
            .where("project_id", "=", project.id)
            .where("issue_type_id", "=", type.id);
        const exists = await where(trx.selectFrom("track_project_issue_type"))
          .select("issue_type_id")
          .executeTakeFirst();
        if (exists) {
          // Tickets keep their status ids. A workflow without that status would strand them.
          const stranded = await trx
            .selectFrom("track_issue")
            .select("id")
            .where("project_id", "=", project.id)
            .where("type_id", "=", type.id)
            .where(
              "status_id",
              "not in",
              trx
                .selectFrom("track_workflow_status")
                .select("status_id")
                .where("workflow_id", "=", workflowId),
            )
            .limit(1)
            .executeTakeFirst();
          if (stranded)
            throw new AppError(
              409,
              "conflict",
              "Tickets of this type are in a status the new workflow does not have",
            );
          await trx
            .updateTable("track_project_issue_type")
            .set({ workflow_id: workflowId, field_layout_id: fieldLayoutId })
            .where("project_id", "=", project.id)
            .where("issue_type_id", "=", type.id)
            .execute();
        } else {
          await trx
            .insertInto("track_project_issue_type")
            .values({
              project_id: project.id,
              issue_type_id: type.id,
              workflow_id: workflowId,
              field_layout_id: fieldLayoutId,
            })
            .execute();
        }
      });
      return issueTypes(project.id);
    },
  );

  r.delete(
    "/projects/:key/issue-types/:typeId",
    {
      config: custom,
      schema: { params: typeParams, response: { 204: z.null() } },
    },
    async (req, reply) => {
      const project = await ctx.project(
        req.user,
        req.params.key,
        "project.administer",
      );
      const used = await db
        .selectFrom("track_issue")
        .select("id")
        .where("project_id", "=", project.id)
        .where("type_id", "=", req.params.typeId)
        .limit(1)
        .executeTakeFirst();
      if (used)
        throw new AppError(
          409,
          "conflict",
          "This issue type still has tickets in the project",
        );
      await db
        .deleteFrom("track_project_issue_type")
        .where("project_id", "=", project.id)
        .where("issue_type_id", "=", req.params.typeId)
        .execute();
      return reply.status(204).send(null);
    },
  );

  // --- Who holds which role ---------------------------------------------------------

  const memberSchema = z.object({
    roleId: z.string(),
    principalType: z.enum(["user", "group"]),
    principalId: z.string(),
  });

  r.get(
    "/projects/:key/members",
    {
      config: custom,
      schema: {
        params: keyParam,
        response: {
          200: z.object({
            roles: z.array(z.object({ id: z.string(), name: z.string() })),
            members: z.array(memberSchema),
          }),
        },
      },
    },
    async (req) => {
      const project = await ctx.project(
        req.user,
        req.params.key,
        "project.administer",
      );
      const [roles, members] = await Promise.all([
        db
          .selectFrom("track_project_role")
          .select(["id", "name"])
          .orderBy("name")
          .execute(),
        db
          .selectFrom("track_project_role_member")
          .selectAll()
          .where("project_id", "=", project.id)
          .execute(),
      ]);
      return {
        roles,
        members: members.map((m) => ({
          roleId: m.role_id,
          principalType: m.principal_type,
          principalId: m.principal_id,
        })),
      };
    },
  );

  r.put(
    "/projects/:key/members",
    {
      config: custom,
      schema: {
        params: keyParam,
        body: memberSchema,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const project = await ctx.project(
        req.user,
        req.params.key,
        "project.administer",
      );
      const { roleId, principalType, principalId } = req.body;
      await db.transaction().execute(async (trx) => {
        const role = await trx
          .selectFrom("track_project_role")
          .select("id")
          .where("id", "=", roleId)
          .executeTakeFirst();
        const principal = await trx
          .selectFrom(principalType === "user" ? "core_user" : "core_group")
          .select("id")
          .where("id", "=", principalId)
          .executeTakeFirst();
        if (!role || !principal)
          throw new AppError(400, "validation", "Unknown role, user or group");
        const row = {
          project_id: project.id,
          role_id: roleId,
          principal_type: principalType,
          principal_id: principalId,
        };
        const exists = await trx
          .selectFrom("track_project_role_member")
          .select("role_id")
          .where("project_id", "=", row.project_id)
          .where("role_id", "=", row.role_id)
          .where("principal_type", "=", row.principal_type)
          .where("principal_id", "=", row.principal_id)
          .executeTakeFirst();
        if (!exists)
          await trx
            .insertInto("track_project_role_member")
            .values(row)
            .execute();
      });
      return reply.status(204).send(null);
    },
  );

  r.delete(
    "/projects/:key/members",
    {
      config: custom,
      schema: {
        params: keyParam,
        body: memberSchema,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const project = await ctx.project(
        req.user,
        req.params.key,
        "project.administer",
      );
      await db
        .deleteFrom("track_project_role_member")
        .where("project_id", "=", project.id)
        .where("role_id", "=", req.body.roleId)
        .where("principal_type", "=", req.body.principalType)
        .where("principal_id", "=", req.body.principalId)
        .execute();
      return reply.status(204).send(null);
    },
  );
}
