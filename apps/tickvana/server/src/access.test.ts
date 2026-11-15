import {
  createPermissions,
  grantGlobal,
  migrateCore,
  SYSTEM_ADMIN,
  uuidv7,
  type AuthUser,
} from "@tvn/core";
import { describeEachDb } from "@tvn/core/testing";
import { beforeAll, expect, it } from "vitest";
import {
  installTrackAccess,
  type ProjectPermission,
  type ProjectTarget,
  type TrackAccess,
} from "./access.js";
import {
  DEFAULTS_SETTING,
  PROJECT_PERMISSIONS,
  type TrackDefaults,
} from "./db/migrations/0002_seed.js";
import { migrateTrack } from "./db/migrations/index.js";
import type { GranteeType, TrackDb } from "./db/schema.js";

describeEachDb<TrackDb>("project permissions", (t) => {
  let access: TrackAccess;
  let d: TrackDefaults;
  const users: Record<string, AuthUser> = {};
  let customSchemeId: string;
  let levelId: string;

  const addUser = async (name: string, kind: AuthUser["kind"] = "internal") => {
    const now = new Date();
    const user: AuthUser = {
      id: uuidv7(),
      email: `${name}@example.org`,
      displayName: name,
      kind,
      locale: "de",
      timezone: "UTC",
    };
    await t.db
      .insertInto("core_user")
      .values({
        id: user.id,
        email: user.email,
        display_name: name,
        password_hash: null,
        kind,
        active: true,
        locale: "de",
        timezone: "UTC",
        created_at: now,
        updated_at: now,
      })
      .execute();
    users[name] = user;
  };
  const addProject = (id: string, schemeId: string, archived = false) =>
    t.db
      .insertInto("track_project")
      .values({
        id,
        key: id.toUpperCase(),
        name: id,
        kind: "software",
        lead_id: users.lead!.id,
        permission_scheme_id: schemeId,
        notification_scheme_id: d.notificationSchemeId,
        issue_counter: 0,
        archived,
        created_at: new Date(),
      })
      .execute();
  const addRole = (
    projectId: string,
    roleId: string,
    type: "user" | "group",
    id: string,
  ) =>
    t.db
      .insertInto("track_project_role_member")
      .values({
        project_id: projectId,
        role_id: roleId,
        principal_type: type,
        principal_id: id,
      })
      .execute();
  const grant = (
    permission: ProjectPermission,
    type: GranteeType,
    id: string | null = null,
  ) =>
    t.db
      .insertInto("track_permission_grant")
      .values({
        id: uuidv7(),
        scheme_id: customSchemeId,
        permission,
        grantee_type: type,
        grantee_id: id,
      })
      .execute();

  beforeAll(async () => {
    await migrateCore(t);
    await migrateTrack(t);
    const permissions = createPermissions(t.db);
    access = installTrackAccess(permissions, t.db);
    d = JSON.parse(
      (
        await t.db
          .selectFrom("core_setting")
          .select("value_json")
          .where("key", "=", DEFAULTS_SETTING)
          .executeTakeFirstOrThrow()
      ).value_json,
    );

    for (const name of [
      "root",
      "lead",
      "member",
      "viewer",
      "outsider",
      "reporter",
      "assignee",
    ])
      await addUser(name);
    await addUser("kunde", "customer");
    await grantGlobal(t.db, SYSTEM_ADMIN, "user", users.root!.id);

    // "alpha" uses the seeded scheme. member belongs through a group.
    const group = uuidv7();
    await t.db
      .insertInto("core_group")
      .values({ id: group, name: "team", created_at: new Date() })
      .execute();
    await t.db
      .insertInto("core_group_member")
      .values({ group_id: group, user_id: users.member!.id })
      .execute();
    await addProject("alpha", d.permissionSchemeId);
    await addRole("alpha", d.roles.administrators, "user", users.lead!.id);
    await addRole("alpha", d.roles.members, "group", group);
    await addRole("alpha", d.roles.viewers, "user", users.viewer!.id);

    // "beta": a custom scheme exercising the other grantee types.
    customSchemeId = uuidv7();
    await t.db
      .insertInto("track_permission_scheme")
      .values({ id: customSchemeId, name: "Offen" })
      .execute();
    await grant("project.browse", "anyone");
    await grant("issue.create", "logged_in");
    await grant("issue.edit", "reporter");
    await grant("issue.transition", "assignee");
    await grant("issue.comment", "user", users.outsider!.id);
    await grant("issue.delete", "customer");
    await addProject("beta", customSchemeId);

    // "gamma": seeded scheme, nobody has a role, archived twin "delta".
    await addProject("gamma", d.permissionSchemeId);
    await addProject("delta", d.permissionSchemeId, true);
    await addRole("delta", d.roles.administrators, "user", users.lead!.id);

    levelId = uuidv7();
    await t.db
      .insertInto("track_security_level")
      .values({ id: levelId, project_id: "alpha", name: "Personal" })
      .execute();
    await t.db
      .insertInto("track_security_level_member")
      .values({
        id: uuidv7(),
        level_id: levelId,
        grantee_type: "role",
        grantee_id: d.roles.administrators,
      })
      .execute();
    await t.db
      .insertInto("track_security_level_member")
      .values({
        id: uuidv7(),
        level_id: levelId,
        grantee_type: "reporter",
        grantee_id: null,
      })
      .execute();
  });

  it("follows the seeded scheme: role × permission", async () => {
    const all = [...PROJECT_PERMISSIONS];
    const memberSet = all.filter(
      (p) => p !== "project.administer" && p !== "issue.delete",
    );
    const expected: Record<string, ProjectPermission[]> = {
      root: all,
      lead: all,
      member: memberSet,
      viewer: ["project.browse"],
      outsider: [],
      kunde: [],
      anonymous: [],
    };
    for (const [name, allowed] of Object.entries(expected)) {
      const user = name === "anonymous" ? null : users[name]!;
      const actual: ProjectPermission[] = [];
      for (const permission of all)
        if (await access.can(user, permission, { projectId: "alpha" }))
          actual.push(permission);
      expect(actual, name).toEqual(allowed);
    }
  });

  it("does not leak roles from one project into another", async () => {
    expect(
      await access.can(users.lead!, "project.browse", { projectId: "gamma" }),
    ).toBe(false);
    expect(
      await access.can(users.lead!, "project.browse", {
        projectId: "does-not-exist",
      }),
    ).toBe(false);
    await expect(
      access.can(users.lead!, "project.browse", {} as ProjectTarget),
    ).rejects.toThrow(/needs a project target/);
  });

  it("evaluates anyone, logged_in, user, reporter and assignee grants", async () => {
    const issue = {
      reporterId: users.reporter!.id,
      assigneeId: users.assignee!.id,
      securityLevelId: null,
    };
    const beta = { projectId: "beta" };
    const onIssue = { projectId: "beta", issue };

    expect(await access.can(null, "project.browse", beta)).toBe(true);
    // "anyone" covers customers only in projects they are customers of (D-1).
    expect(await access.can(users.kunde!, "project.browse", beta)).toBe(false);

    expect(await access.can(users.outsider!, "issue.create", beta)).toBe(true);
    expect(await access.can(users.kunde!, "issue.create", beta)).toBe(false);
    expect(await access.can(null, "issue.create", beta)).toBe(false);

    expect(await access.can(users.reporter!, "issue.edit", onIssue)).toBe(true);
    expect(await access.can(users.assignee!, "issue.edit", onIssue)).toBe(
      false,
    );
    expect(await access.can(users.reporter!, "issue.edit", beta)).toBe(false);
    expect(await access.can(users.assignee!, "issue.transition", onIssue)).toBe(
      true,
    );
    expect(await access.can(users.reporter!, "issue.transition", onIssue)).toBe(
      false,
    );

    expect(await access.can(users.outsider!, "issue.comment", beta)).toBe(true);
    expect(await access.can(users.member!, "issue.comment", beta)).toBe(false);
    expect(await access.can(users.kunde!, "issue.delete", beta)).toBe(false);
    expect(await access.can(users.root!, "issue.delete", beta)).toBe(true);
  });

  it("narrows single tickets by security level", async () => {
    const secured = (reporterId: string) => ({
      projectId: "alpha",
      issue: { reporterId, assigneeId: null, securityLevelId: levelId },
    });
    expect(
      await access.can(
        users.lead!,
        "project.browse",
        secured(users.outsider!.id),
      ),
    ).toBe(true);
    // A member may browse the project, but not this ticket …
    expect(
      await access.can(users.member!, "project.browse", { projectId: "alpha" }),
    ).toBe(true);
    expect(
      await access.can(
        users.member!,
        "project.browse",
        secured(users.outsider!.id),
      ),
    ).toBe(false);
    expect(
      await access.can(
        users.member!,
        "issue.edit",
        secured(users.outsider!.id),
      ),
    ).toBe(false);
    // … unless they reported it.
    expect(
      await access.can(users.member!, "issue.edit", secured(users.member!.id)),
    ).toBe(true);
    // The level only narrows: it never grants what the scheme does not.
    expect(
      await access.can(users.viewer!, "issue.edit", secured(users.viewer!.id)),
    ).toBe(false);
    expect(
      await access.can(users.root!, "issue.edit", secured(users.outsider!.id)),
    ).toBe(true);
  });

  it("freezes archived projects except for looking and administering", async () => {
    const delta = { projectId: "delta" };
    expect(await access.can(users.lead!, "project.browse", delta)).toBe(true);
    expect(await access.can(users.lead!, "project.administer", delta)).toBe(
      true,
    );
    expect(await access.can(users.lead!, "issue.create", delta)).toBe(false);
    expect(await access.can(users.lead!, "issue.comment", delta)).toBe(false);
    await expect(
      access.require(users.lead!, "issue.create", delta),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      access.require(null, "issue.create", delta),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("lists the projects a user may browse", async () => {
    const visible = async (name: string | null) =>
      (await access.visibleProjectIds(name ? users[name]! : null)).sort();
    expect(await visible("root")).toEqual(["alpha", "beta", "delta", "gamma"]);
    expect(await visible("lead")).toEqual(["alpha", "beta", "delta"]);
    expect(await visible("member")).toEqual(["alpha", "beta"]);
    expect(await visible("viewer")).toEqual(["alpha", "beta"]);
    expect(await visible("outsider")).toEqual(["beta"]);
    // Customers get no project-wide lists; the portal shows their tickets.
    expect(await visible("kunde")).toEqual([]);
    expect(await visible(null)).toEqual(["beta"]);
  });
});
