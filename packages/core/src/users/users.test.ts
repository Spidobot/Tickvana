import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { installAuth } from "../auth/routes.js";
import {
  checkPassword,
  createApiToken,
  createSession,
  resetPassword,
  resolveSession,
} from "../auth/store.js";
import { uuidv7 } from "../db/index.js";
import { createMailer } from "../mail/index.js";
import { migrateCore } from "../migrations/index.js";
import {
  createPermissions,
  grantGlobal,
  SYSTEM_ADMIN,
  type Permissions,
} from "../permissions/index.js";
import { createQueue } from "../queue/index.js";
import type { CoreDb } from "../schema.js";
import { createServer } from "../server/index.js";
import { describeEachDb } from "../testing/index.js";
import { installUserRoutes } from "./index.js";

const SECRET_KEY = "u".repeat(32);

describeEachDb<CoreDb>("users and groups", (t) => {
  let app: FastifyInstance;
  let permissions: Permissions;
  const bearer: Record<string, { authorization: string }> = {};
  const ids: Record<string, string> = {};

  const seed = async (
    name: string,
    kind: CoreDb["core_user"]["kind"] = "internal",
  ) => {
    const now = new Date();
    ids[name] = uuidv7();
    await t.db
      .insertInto("core_user")
      .values({
        id: ids[name],
        email: `${name}@example.org`,
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
    bearer[name] = {
      authorization: `Bearer ${(await createApiToken(t.db, ids[name], "t", null)).token}`,
    };
  };

  beforeAll(async () => {
    await migrateCore(t);
    permissions = createPermissions(t.db);
    const queue = createQueue(t.db);
    const mailer = createMailer(t.db, SECRET_KEY, queue);
    await seed("admin");
    await seed("staff");
    await seed("kunde", "customer");
    await grantGlobal(t.db, SYSTEM_ADMIN, "user", ids.admin!);
    app = await createServer({
      name: "t",
      version: "0",
      prefix: "/t",
      routes: async (scope) => {
        await installAuth(scope, {
          db: t.db,
          permissions,
          baseUrl: "http://localhost",
          secretKey: SECRET_KEY,
          sendPasswordReset: async () => {},
        });
        await installUserRoutes(scope, {
          db: t.db,
          permissions,
          queue,
          mailer,
          secretKey: SECRET_KEY,
          setPasswordUrl: (token) =>
            `http://localhost/t/reset-password?token=${encodeURIComponent(token)}`,
        });
      },
    });
  });

  afterAll(() => app?.close());

  const call = (
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    as: string | null,
    payload?: object,
  ) =>
    app.inject({
      method,
      url: `/t/api/core${url}`,
      payload,
      headers: as ? bearer[as] : { origin: "http://localhost" },
    });

  it("creates users for managers only, with unique normalized e-mail", async () => {
    const body = {
      email: "Bea@Example.org",
      displayName: "Bea Berg",
      password: "ein langes passwort",
    };
    expect((await call("POST", "/users", "staff", body)).statusCode).toBe(403);
    expect((await call("POST", "/users", null, body)).statusCode).toBe(401);

    const made = await call("POST", "/users", "admin", body);
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({
      email: "bea@example.org",
      kind: "internal",
      active: true,
      locale: "en",
    });
    expect(made.body).not.toContain("password");
    expect(
      await checkPassword(t.db, "bea@example.org", "ein langes passwort"),
    ).not.toBeNull();

    expect(
      (
        await call("POST", "/users", "admin", {
          ...body,
          email: "BEA@example.org",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await call("POST", "/users", "admin", { ...body, email: "kein-at" }))
        .statusCode,
    ).toBe(400);

    const events = await t.db
      .selectFrom("core_event")
      .select(["type", "actor_id", "entity_id"])
      .where("type", "=", "user.created")
      .execute();
    expect(events).toEqual([
      { type: "user.created", actor_id: ids.admin, entity_id: made.json().id },
    ]);
  });

  it("invites by mail with a link that sets the password", async () => {
    const made = await call("POST", "/users", "admin", {
      email: "neu@example.org",
      displayName: "Neu",
      locale: "de",
      invite: true,
    });
    expect(made.statusCode).toBe(201);
    const job = await t.db
      .selectFrom("core_job")
      .selectAll()
      .where("type", "=", "mail.send")
      .executeTakeFirstOrThrow();
    const mail = JSON.parse(job.payload_json);
    expect(mail).toMatchObject({
      to: "neu@example.org",
      subject: "Dein Konto wurde angelegt",
    });
    expect(mail.body[0]).toContain("admin");

    const token = new URL(mail.action.url).searchParams.get("token")!;
    // Still valid after six days, gone after eight.
    const day = 24 * 60 * 60 * 1000;
    expect(
      await resetPassword(
        t.db,
        SECRET_KEY,
        token,
        "x".repeat(12),
        new Date(Date.now() + 8 * day),
      ),
    ).toBe(false);
    expect(
      await resetPassword(
        t.db,
        SECRET_KEY,
        token,
        "mein neues passwort",
        new Date(Date.now() + 6 * day),
      ),
    ).toBe(true);
    expect(
      await checkPassword(t.db, "neu@example.org", "mein neues passwort"),
    ).not.toBeNull();
  });

  it("searches people for staff, never for customers", async () => {
    const names = async (query: string, as = "staff") =>
      (await call("GET", `/users${query}`, as))
        .json()
        .map((u: { displayName: string }) => u.displayName);

    expect(await names("?q=BEA")).toEqual(["Bea Berg"]);
    expect(await names("?q=example.org&limit=2")).toHaveLength(2);
    expect(await names("?q=example.org&limit=2&offset=2")).not.toEqual(
      await names("?q=example.org&limit=2"),
    );
    expect(await names("?kind=customer")).toEqual(["kunde"]);
    // % and _ are text, not wildcards.
    expect(await names("?q=%25")).toEqual([]);
    expect(await names("?q=_")).toEqual([]);

    expect((await call("GET", "/users", "kunde")).statusCode).toBe(403);
    expect((await call("GET", `/users/${ids.staff}`, "kunde")).statusCode).toBe(
      403,
    );
    expect((await call("GET", "/users", null)).statusCode).toBe(401);
    expect(
      (await call("GET", `/users/${ids.staff}`, "staff")).json().displayName,
    ).toBe("staff");
  });

  it("lets people edit their own profile and managers the rest", async () => {
    const own = await call("PATCH", `/users/${ids.staff}`, "staff", {
      displayName: "Stefanie",
      timezone: "Europe/Vienna",
    });
    expect(own.json()).toMatchObject({
      displayName: "Stefanie",
      timezone: "Europe/Vienna",
      email: "staff@example.org",
    });

    expect(
      (await call("PATCH", `/users/${ids.staff}`, "staff", { kind: "service" }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await call("PATCH", `/users/${ids.staff}`, "staff", {
          email: "x@example.org",
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call("PATCH", `/users/${ids.admin}`, "staff", {
          displayName: "Hacked",
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call("PATCH", `/users/${ids.staff}`, "admin", {
          email: "admin@example.org",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call("PATCH", `/users/${ids.staff}`, "admin", {
          email: "Steffi@example.org",
        })
      ).json().email,
    ).toBe("steffi@example.org");
  });

  it("deactivates instead of deleting, ending sessions at once", async () => {
    await seed("geht");
    const session = await createSession(t.db, ids.geht!);
    expect(await resolveSession(t.db, session)).not.toBeNull();

    expect(
      (await call("PATCH", `/users/${ids.admin}`, "admin", { active: false }))
        .statusCode,
    ).toBe(409);
    const off = await call("PATCH", `/users/${ids.geht}`, "admin", {
      active: false,
    });
    expect(off.json().active).toBe(false);
    expect(await resolveSession(t.db, session)).toBeNull();
    expect((await call("GET", "/users?q=geht", "geht")).statusCode).toBe(401);

    const find = async (query: string, as: string) =>
      (await call("GET", `/users?q=geht${query}`, as)).json();
    expect(await find("", "staff")).toEqual([]);
    expect(
      (await call("GET", "/users?q=geht&includeInactive=true", "staff"))
        .statusCode,
    ).toBe(403);
    expect(await find("&includeInactive=true", "admin")).toHaveLength(1);
    expect(
      await t.db
        .selectFrom("core_event")
        .select("type")
        .where("entity_id", "=", ids.geht!)
        .execute(),
    ).toEqual([{ type: "user.deactivated" }]);

    expect(
      (
        await call("PATCH", `/users/${ids.geht}`, "admin", { active: true })
      ).json().active,
    ).toBe(true);
  });

  it("manages groups and members, and cleans up grants on delete", async () => {
    expect(
      (await call("POST", "/groups", "staff", { name: "Entwicklung" }))
        .statusCode,
    ).toBe(403);
    const group = (
      await call("POST", "/groups", "admin", { name: "Entwicklung" })
    ).json();
    expect(
      (await call("POST", "/groups", "admin", { name: "Entwicklung" }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await call("PATCH", `/groups/${group.id}`, "admin", { name: "Dev" })
      ).json(),
    ).toEqual({ id: group.id, name: "Dev" });
    expect((await call("GET", "/groups", "staff")).json()).toContainEqual({
      id: group.id,
      name: "Dev",
    });
    expect((await call("GET", "/groups", "kunde")).statusCode).toBe(403);

    const member = `/groups/${group.id}/members/${ids.staff}`;
    expect((await call("PUT", member, "staff")).statusCode).toBe(403);
    expect((await call("PUT", member, "admin")).statusCode).toBe(204);
    expect((await call("PUT", member, "admin")).statusCode).toBe(204);
    expect(
      (await call("PUT", `/groups/${group.id}/members/${uuidv7()}`, "admin"))
        .statusCode,
    ).toBe(404);
    const members = (
      await call("GET", `/groups/${group.id}/members`, "staff")
    ).json();
    expect(members.map((m: { id: string }) => m.id)).toEqual([ids.staff]);

    // Group membership carries permissions …
    await grantGlobal(t.db, "user.manage", "group", group.id);
    expect(
      (await call("POST", "/groups", "staff", { name: "Durch Gruppe" }))
        .statusCode,
    ).toBe(201);
    expect((await call("DELETE", member, "admin")).statusCode).toBe(204);
    expect(
      (await call("POST", "/groups", "staff", { name: "Nicht mehr" }))
        .statusCode,
    ).toBe(403);

    // … and deleting the group removes its grants and members.
    await call("PUT", member, "admin");
    expect(
      (await call("DELETE", `/groups/${group.id}`, "admin")).statusCode,
    ).toBe(204);
    expect(
      await t.db
        .selectFrom("core_global_grant")
        .select("id")
        .where("grantee_id", "=", group.id)
        .execute(),
    ).toEqual([]);
    expect(
      await t.db
        .selectFrom("core_group_member")
        .select("user_id")
        .where("group_id", "=", group.id)
        .execute(),
    ).toEqual([]);
    expect(
      (await call("GET", `/groups/${group.id}/members`, "staff")).statusCode,
    ).toBe(404);
  });
});
