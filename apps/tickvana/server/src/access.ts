// Who may do what in a project. Plugs Tickvana's permission schemes, project
// roles and security levels into the permission core (CONCEPT.md §5).
import {
  getSetting,
  type AuthUser,
  type CoreDb,
  type Permissions,
} from "@tvn/core";
import { z } from "zod";
import type { Kysely } from "kysely";
import { PROJECT_PERMISSIONS } from "./db/migrations/0002_seed.js";
import type { GranteeType, TrackDb } from "./db/schema.js";

export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[number];

/** What a project-scoped check is made against. Pass `issue` for anything about one ticket. */
export interface ProjectTarget {
  projectId: string;
  issue?: {
    reporterId: string;
    assigneeId: string | null;
    securityLevelId: string | null;
  };
}

/** Builds the `issue` part of a target from an issue row. */
export const issueTarget = (
  issue: Pick<
    TrackDb["track_issue"],
    "project_id" | "reporter_id" | "assignee_id" | "security_level_id"
  >,
): ProjectTarget => ({
  projectId: issue.project_id,
  issue: {
    reporterId: issue.reporter_id,
    assigneeId: issue.assignee_id,
    securityLevelId: issue.security_level_id,
  },
});

export interface SecurityLevelAccess {
  /** System administrators pass every level. */
  all: boolean;
  /** Levels the user passes whatever their relation to the ticket. */
  always: string[];
  /** Levels the user passes on tickets they reported. */
  asReporter: string[];
  /** Levels the user passes on tickets assigned to them. */
  asAssignee: string[];
}

export interface TrackAccess {
  can(
    user: AuthUser | null,
    permission: ProjectPermission,
    target: ProjectTarget,
  ): Promise<boolean>;
  require(
    user: AuthUser | null,
    permission: ProjectPermission,
    target: ProjectTarget,
  ): Promise<void>;
  /**
   * Projects the user may browse as a whole, for lists and the query engine.
   * Access that exists only for single tickets (a grant to "reporter" or
   * "assignee") is not part of this: check those tickets one by one.
   */
  visibleProjectIds(user: AuthUser | null): Promise<string[]>;
  /**
   * Which security levels let this user through, for filtering many tickets
   * in SQL. A ticket without a level is not restricted by any of this.
   */
  securityLevels(user: AuthUser | null): Promise<SecurityLevelAccess>;
}

/** Still allowed in an archived project: looking, and un-archiving. */
const ARCHIVE_SAFE = new Set<string>(["project.browse", "project.administer"]);

export const PORTAL_SETTING = "track.portal";
export const portalSettings = z.object({
  /** Anyone may sign up in the portal. */
  signup: z.boolean().default(false),
  /** Projects every customer may use, without being added. */
  openProjectIds: z.array(z.string()).default([]),
});

/** The most a customer can ever get in a project, whatever a scheme grants. */
const CUSTOMER_PERMISSIONS = new Set<string>([
  "project.browse",
  "issue.create",
  "issue.comment",
  "issue.attach",
]);

interface Grant {
  grantee_type: GranteeType;
  grantee_id: string | null;
}

export function installTrackAccess(
  permissions: Permissions,
  db: Kysely<TrackDb>,
): TrackAccess {
  permissions.define("project.create", "global");
  for (const key of PROJECT_PERMISSIONS) permissions.define(key, "project");

  /** Role ids the user holds in a project, directly or through a group. */
  async function roleIds(
    userId: string,
    groupIds: string[],
    projectId?: string,
  ): Promise<Map<string, Set<string>>> {
    let query = db
      .selectFrom("track_project_role_member")
      .select(["project_id", "role_id"])
      .where((eb) =>
        eb.or([
          eb.and([
            eb("principal_type", "=", "user"),
            eb("principal_id", "=", userId),
          ]),
          ...(groupIds.length
            ? [
                eb.and([
                  eb("principal_type", "=", "group"),
                  eb("principal_id", "in", groupIds),
                ]),
              ]
            : []),
        ]),
      );
    if (projectId) query = query.where("project_id", "=", projectId);
    const byProject = new Map<string, Set<string>>();
    for (const row of await query.execute()) {
      if (!byProject.has(row.project_id))
        byProject.set(row.project_id, new Set());
      byProject.get(row.project_id)!.add(row.role_id);
    }
    return byProject;
  }

  interface Principal {
    user: AuthUser | null;
    groupIds: Set<string>;
    roles: Set<string>;
  }

  function matches(
    grant: Grant,
    who: Principal,
    issue: ProjectTarget["issue"],
  ): boolean {
    const { user } = who;
    switch (grant.grantee_type) {
      case "anyone":
        return true;
      case "logged_in":
        // Portal customers are signed in, but "logged in" means staff.
        return user !== null && user.kind !== "customer";
      case "user":
        return user !== null && grant.grantee_id === user.id;
      case "group":
        return grant.grantee_id !== null && who.groupIds.has(grant.grantee_id);
      case "role":
        return grant.grantee_id !== null && who.roles.has(grant.grantee_id);
      case "reporter":
        return user !== null && issue?.reporterId === user.id;
      case "assignee":
        return user !== null && issue?.assigneeId === user.id;
      case "customer":
        // Customers are checked by customerCan(); staff never match.
        return false;
    }
  }

  /** Is the user a customer of the project, directly or through an organization? */
  async function isCustomerOf(userId: string, projectId: string) {
    const portal = await getSetting(
      db as unknown as Kysely<CoreDb>,
      PORTAL_SETTING,
      portalSettings,
    );
    if (portal.openProjectIds.includes(projectId)) return true;
    const orgs = (
      await db
        .selectFrom("track_organization_member")
        .select("organization_id")
        .where("user_id", "=", userId)
        .execute()
    ).map((o) => o.organization_id);
    const row = await db
      .selectFrom("track_project_customer")
      .select("project_id")
      .where("project_id", "=", projectId)
      .where((eb) =>
        eb.or([
          eb.and([
            eb("principal_type", "=", "user"),
            eb("principal_id", "=", userId),
          ]),
          ...(orgs.length
            ? [
                eb.and([
                  eb("principal_type", "=", "organization"),
                  eb("principal_id", "in", orgs),
                ]),
              ]
            : []),
        ]),
      )
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Customers: only portal rights, only in their projects, only their own and their organization's tickets. */
  async function customerCan(
    user: AuthUser,
    permission: string,
    target: ProjectTarget,
    schemeId: string,
  ) {
    if (!CUSTOMER_PERMISSIONS.has(permission)) return false;
    const granted = await db
      .selectFrom("track_permission_grant")
      .select("id")
      .where("scheme_id", "=", schemeId)
      .where("permission", "=", permission)
      .where("grantee_type", "in", ["customer", "anyone"])
      .executeTakeFirst();
    if (!granted || !(await isCustomerOf(user.id, target.projectId)))
      return false;
    const issue = target.issue;
    if (!issue) return true;
    if (issue.reporterId !== user.id) {
      const shared = await db
        .selectFrom("track_organization_member as a")
        .innerJoin(
          "track_organization_member as b",
          "a.organization_id",
          "b.organization_id",
        )
        .select("a.organization_id")
        .where("a.user_id", "=", user.id)
        .where("b.user_id", "=", issue.reporterId)
        .executeTakeFirst();
      if (!shared) return false;
    }
    if (!issue.securityLevelId) return true;
    const members = await db
      .selectFrom("track_security_level_member")
      .select(["grantee_type", "grantee_id"])
      .where("level_id", "=", issue.securityLevelId)
      .execute();
    return members.some(
      (m) =>
        (m.grantee_type === "reporter" && issue.reporterId === user.id) ||
        (m.grantee_type === "user" && m.grantee_id === user.id) ||
        m.grantee_type === "customer" ||
        m.grantee_type === "anyone",
    );
  }

  permissions.registerScope("project", async (user, permission, rawTarget) => {
    const target = rawTarget as ProjectTarget | undefined;
    if (!target?.projectId)
      throw new Error(`Permission "${permission}" needs a project target`);

    const project = await db
      .selectFrom("track_project")
      .select(["permission_scheme_id", "archived"])
      .where("id", "=", target.projectId)
      .executeTakeFirst();
    if (!project) return false;
    if (project.archived && !ARCHIVE_SAFE.has(permission)) return false;
    if (user?.kind === "customer")
      return customerCan(
        user,
        permission,
        target,
        project.permission_scheme_id,
      );

    const groupIds = user ? await permissions.groupIds(user.id) : [];
    const who: Principal = {
      user,
      groupIds: new Set(groupIds),
      roles: user
        ? ((await roleIds(user.id, groupIds, target.projectId)).get(
            target.projectId,
          ) ?? new Set())
        : new Set(),
    };

    const grants = await db
      .selectFrom("track_permission_grant")
      .select(["grantee_type", "grantee_id"])
      .where("scheme_id", "=", project.permission_scheme_id)
      .where("permission", "=", permission)
      .execute();
    if (!grants.some((g) => matches(g, who, target.issue))) return false;

    // A security level narrows who may touch this one ticket, whatever the scheme says.
    const levelId = target.issue?.securityLevelId;
    if (!levelId) return true;
    const members = await db
      .selectFrom("track_security_level_member")
      .select(["grantee_type", "grantee_id"])
      .where("level_id", "=", levelId)
      .execute();
    return members.some((m) => matches(m, who, target.issue));
  });

  return {
    can: (user, permission, target) =>
      permissions.can(user, permission, target),
    require: (user, permission, target) =>
      permissions.require(user, permission, target),

    async securityLevels(user) {
      const out: SecurityLevelAccess = {
        all: false,
        always: [],
        asReporter: [],
        asAssignee: [],
      };
      if (user && (await permissions.can(user, "system.admin")))
        return { ...out, all: true };
      const members = await db
        .selectFrom("track_security_level_member as m")
        .innerJoin("track_security_level as l", "l.id", "m.level_id")
        .select([
          "m.level_id",
          "m.grantee_type",
          "m.grantee_id",
          "l.project_id",
        ])
        .execute();
      if (members.length === 0) return out;
      const groupIds = user ? await permissions.groupIds(user.id) : [];
      const roles = user
        ? await roleIds(user.id, groupIds)
        : new Map<string, Set<string>>();
      const always = new Set<string>();
      const asReporter = new Set<string>();
      const asAssignee = new Set<string>();
      for (const m of members) {
        if (m.grantee_type === "reporter") {
          if (user) asReporter.add(m.level_id);
        } else if (m.grantee_type === "assignee") {
          if (user) asAssignee.add(m.level_id);
        } else if (
          matches(
            m,
            {
              user,
              groupIds: new Set(groupIds),
              roles: roles.get(m.project_id) ?? new Set(),
            },
            undefined,
          )
        ) {
          always.add(m.level_id);
        }
      }
      return {
        all: false,
        always: [...always],
        asReporter: [...asReporter],
        asAssignee: [...asAssignee],
      };
    },

    async visibleProjectIds(user) {
      // Customers never see project-wide lists; the portal shows their tickets one by one.
      if (user?.kind === "customer") return [];
      const projects = await db
        .selectFrom("track_project")
        .select(["id", "permission_scheme_id"])
        .execute();
      if (user && (await permissions.can(user, "system.admin")))
        return projects.map((p) => p.id);

      const grants = await db
        .selectFrom("track_permission_grant")
        .select(["scheme_id", "grantee_type", "grantee_id"])
        .where("permission", "=", "project.browse")
        .execute();
      const groupIds = user ? await permissions.groupIds(user.id) : [];
      const roles = user
        ? await roleIds(user.id, groupIds)
        : new Map<string, Set<string>>();

      return projects
        .filter((p) => {
          const who: Principal = {
            user,
            groupIds: new Set(groupIds),
            roles: roles.get(p.id) ?? new Set(),
          };
          return grants.some(
            (g) =>
              g.scheme_id === p.permission_scheme_id &&
              matches(g, who, undefined),
          );
        })
        .map((p) => p.id);
    },
  };
}
