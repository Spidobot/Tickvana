import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { installAuth } from "../auth/routes.js";
import { createApiToken, type AuthUser } from "../auth/store.js";
import { uuidv7 } from "../db/index.js";
import { migrateCore } from "../migrations/index.js";
import type { CoreDb } from "../schema.js";
import { createServer } from "../server/index.js";
import { describeEachDb } from "../testing/index.js";
import {
  createPermissions,
  grantGlobal,
  installPermissionRoutes,
  SYSTEM_ADMIN,
  type Permissions,
} from "./index.js";

describeEachDb<CoreDb>("permissions", (t) => {
  let app: FastifyInstance;
  let permissions: Permissions;
  const users: Record<string, AuthUser> = {};
  const bearer: Record<string, { authorization: string }> = {};
  let staffGroup: string;
  const seen: unknown[] = [];

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
    bearer[name] = {
      authorization: `Bearer ${(await createApiToken(t.db, user.id, "t", null)).token}`,
    };
  };

  const build = (extra?: (scope: FastifyInstance) => void) =>
    createServer({
      name: "track",
      version: "0",
      prefix: "/t",
      routes: async (scope) => {
        await installAuth(scope, {
          db: t.db,
          permissions,
          baseUrl: "http://localhost",
          secretKey: "s".repeat(32),
          sendPasswordReset: async () => {},
        });
        await installPermissionRoutes(scope, t.db, permissions);
        scope.get(
          "/open",
          { config: { permission: "public" } },
          async () => "open",
        );
        scope.get(
          "/signed",
          { config: { permission: "authenticated" } },
          async () => "signed",
        );
        scope.get(
          "/sql",
          { config: { permission: "query.sql" } },
          async () => "sql",
        );
        scope.get(
          "/custom",
          { config: { permission: "custom" } },
          async () => "custom",
        );
        scope.get<{ Params: { id: string } }>(
          "/projects/:id",
          {
            config: {
              permission: {
                key: "project.browse",
                target: (req) => (req.params as { id: string }).id,
              },
            },
          },
          async () => "project",
        );
        extra?.(scope);
      },
    });

  beforeAll(async () => {
    await migrateCore(t);
    permissions = createPermissions(t.db);
    permissions.define("project.browse", "project");
    // Stand-in for Tickvana: project "p1" is visible to dora only.
    permissions.registerScope("project", async (user, key, target) => {
      seen.push([user?.email, key, target]);
      return target === "p1" && user?.email === "dora@example.org";
    });

    for (const name of ["root", "dora", "erin", "frank"]) await addUser(name);
    await addUser("cust", "customer");
    staffGroup = uuidv7();
    await t.db
      .insertInto("core_group")
      .values({ id: staffGroup, name: "staff", created_at: new Date() })
      .execute();
    await t.db
      .insertInto("core_group_member")
      .values({ group_id: staffGroup, user_id: users.erin!.id })
      .execute();
    await grantGlobal(t.db, SYSTEM_ADMIN, "user", users.root!.id);
    app = await build();
  });

  afterAll(() => app?.close());

  it("refuses unknown permission keys instead of guessing", async () => {
    await expect(permissions.can(users.root!, "project.brwse")).rejects.toThrow(
      /Unknown permission/,
    );
    expect(() => permissions.define("query.sql", "global")).toThrow(
      /already defined/,
    );
  });

  it("decides global permissions by user, group, logged_in and anyone", async () => {
    const can = (name: string | null) =>
      permissions.can(name ? users[name]! : null, "query.sql");
    expect(await can("dora")).toBe(false);

    const byUser = await grantGlobal(t.db, "query.sql", "user", users.dora!.id);
    expect(await grantGlobal(t.db, "query.sql", "user", users.dora!.id)).toBe(
      byUser,
    );
    expect([await can("dora"), await can("erin"), await can(null)]).toEqual([
      true,
      false,
      false,
    ]);

    await grantGlobal(t.db, "query.sql", "group", staffGroup);
    expect([await can("erin"), await can("frank")]).toEqual([true, false]);

    const loggedIn = await grantGlobal(t.db, "query.sql", "logged_in");
    expect([await can("frank"), await can("cust"), await can(null)]).toEqual([
      true,
      false,
      false,
    ]);

    const anyone = await grantGlobal(t.db, "query.sql", "anyone");
    expect([await can("cust"), await can(null)]).toEqual([true, true]);

    await t.db
      .deleteFrom("core_global_grant")
      .where("id", "in", [loggedIn, anyone])
      .execute();
    expect([await can("frank"), await can(null)]).toEqual([false, false]);
  });

  it("lets the scope resolver decide, and system admins pass everything", async () => {
    seen.length = 0;
    expect(await permissions.can(users.dora!, "project.browse", "p1")).toBe(
      true,
    );
    expect(await permissions.can(users.dora!, "project.browse", "p2")).toBe(
      false,
    );
    expect(await permissions.can(null, "project.browse", "p1")).toBe(false);
    expect(seen).toEqual([
      ["dora@example.org", "project.browse", "p1"],
      ["dora@example.org", "project.browse", "p2"],
      [undefined, "project.browse", "p1"],
    ]);
    expect(await permissions.can(users.root!, "project.browse", "p2")).toBe(
      true,
    );
    expect(await permissions.can(users.root!, "user.manage")).toBe(true);
  });

  it("answers 401 to strangers and 403 to signed-in users", async () => {
    await expect(
      permissions.require(null, "user.manage"),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      permissions.require(users.frank!, "user.manage"),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      permissions.require(users.root!, "user.manage"),
    ).resolves.toBeUndefined();
  });

  it("will not register a route without a declared permission", async () => {
    await expect(
      build((scope) => scope.get("/forgotten", async () => "leak")),
    ).rejects.toThrow(/GET \/t\/api\/forgotten declares no permission/);
  });

  it("enforces what routes declare", async () => {
    const status = async (url: string, as?: string) =>
      (await app.inject({ url: `/t/api${url}`, headers: as ? bearer[as] : {} }))
        .statusCode;

    expect(await status("/open")).toBe(200);
    expect(await status("/custom")).toBe(200);
    expect([await status("/signed"), await status("/signed", "frank")]).toEqual(
      [401, 200],
    );
    // dora and the staff group hold query.sql from the test above.
    expect([
      await status("/sql"),
      await status("/sql", "frank"),
      await status("/sql", "dora"),
    ]).toEqual([401, 403, 200]);
    expect([
      await status("/projects/p1", "dora"),
      await status("/projects/p2", "dora"),
      await status("/projects/p1", "frank"),
      await status("/projects/p2", "root"),
      await status("/projects/p1"),
    ]).toEqual([200, 403, 403, 200, 401]);
  });

  it("lets only system admins manage global grants, and keeps the last admin", async () => {
    const url = "/t/api/core/permissions/global";
    expect((await app.inject({ url, headers: bearer.dora })).statusCode).toBe(
      403,
    );

    const listed = (await app.inject({ url, headers: bearer.root })).json();
    expect(listed.permissions).toEqual(
      expect.arrayContaining([SYSTEM_ADMIN, "user.manage", "query.sql"]),
    );
    expect(listed.permissions).not.toContain("project.browse");
    const rootGrant = listed.grants.find(
      (g: { permission: string }) => g.permission === SYSTEM_ADMIN,
    );

    const grant = (payload: object) =>
      app.inject({ method: "POST", url, payload, headers: bearer.root });
    expect(
      (
        await grant({
          permission: "nope",
          granteeType: "anyone",
          granteeId: null,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await grant({
          permission: SYSTEM_ADMIN,
          granteeType: "anyone",
          granteeId: null,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await grant({
          permission: "user.manage",
          granteeType: "user",
          granteeId: null,
        })
      ).statusCode,
    ).toBe(400);

    const made = await grant({
      permission: "user.manage",
      granteeType: "user",
      granteeId: users.frank!.id,
    });
    expect(made.statusCode).toBe(201);
    expect(await permissions.can(users.frank!, "user.manage")).toBe(true);

    const remove = (id: string) =>
      app.inject({
        method: "DELETE",
        url: `${url}/${id}`,
        headers: bearer.root,
      });
    expect((await remove(made.json().id)).statusCode).toBe(204);
    expect(await permissions.can(users.frank!, "user.manage")).toBe(false);

    const last = await remove(rootGrant.id);
    expect(last.statusCode).toBe(409);
    expect(last.json().error.code).toBe("last_admin");
    expect(await permissions.can(users.root!, SYSTEM_ADMIN)).toBe(true);
  });
});
