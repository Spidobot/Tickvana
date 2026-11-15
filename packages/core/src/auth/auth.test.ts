import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { uuidv7 } from "../db/index.js";
import { migrateCore } from "../migrations/index.js";
import type { CoreDb } from "../schema.js";
import { createServer } from "../server/index.js";
import { describeEachDb } from "../testing/index.js";
import { createPermissions } from "../permissions/index.js";
import { installAuth, requireUser } from "./routes.js";
import { hashPassword } from "./store.js";

const ORIGIN = "https://work.example.org";
const PASSWORD = "correct horse battery";

describeEachDb<CoreDb>("authentication", (t) => {
  let track: FastifyInstance;
  let pages: FastifyInstance;
  let strict: FastifyInstance;
  const resets: string[] = [];

  const server = (prefix: string, rateLimitMax: number) =>
    createServer({
      name: prefix.slice(1),
      version: "0",
      prefix,
      routes: async (scope) => {
        await installAuth(scope, {
          db: t.db,
          permissions: createPermissions(t.db),
          baseUrl: ORIGIN,
          secretKey: "s".repeat(32),
          sendPasswordReset: async (_user, token) => void resets.push(token),
          rateLimitMax,
        });
        scope.post(
          "/thing",
          { config: { permission: "authenticated" } },
          async (req) => ({ by: requireUser(req).email }),
        );
      },
    });

  const addUser = async (email: string, active = true) => {
    const now = new Date();
    const id = uuidv7();
    await t.db
      .insertInto("core_user")
      .values({
        id,
        email,
        display_name: email,
        password_hash: await hashPassword(PASSWORD),
        kind: "internal",
        active,
        locale: "de",
        timezone: "UTC",
        created_at: now,
        updated_at: now,
      })
      .execute();
    return id;
  };

  const post = (
    app: FastifyInstance,
    url: string,
    payload: object,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: "POST",
      url,
      payload,
      headers: { origin: ORIGIN, ...headers },
    });

  const login = async (email: string, password = PASSWORD, app = track) => {
    const res = await post(app, "/tickvana/api/core/auth/login", {
      email,
      password,
    });
    const set = res.headers["set-cookie"];
    const header = Array.isArray(set) ? set[0] : set;
    return { res, header, cookie: header?.split(";")[0] ?? "" };
  };

  beforeAll(async () => {
    await migrateCore(t);
    track = await server("/tickvana", 1000);
    pages = await server("/nuvenna", 1000);
    strict = await server("/tickvana", 3);
    await addUser("ada@example.org");
    await addUser("gone@example.org", false);
  });

  afterAll(() => Promise.all([track, pages, strict].map((a) => a?.close())));

  it("signs in with a hardened cookie and stores only its hash", async () => {
    const { res, header, cookie } = await login("  ADA@example.org ");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      email: "ada@example.org",
      kind: "internal",
    });
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/SameSite=Lax/);
    expect(header).toMatch(/Path=\//);
    expect(header).toMatch(/Secure/);

    const value = cookie.split("=")[1]!;
    const sessions = await t.db
      .selectFrom("core_session")
      .select("id_hash")
      .execute();
    expect(sessions.map((s) => s.id_hash)).not.toContain(value);

    const me = await track.inject({
      url: "/tickvana/api/core/auth/me",
      headers: { cookie },
    });
    expect(me.json().email).toBe("ada@example.org");
  });

  it("accepts a Tickvana session in Nuvenna", async () => {
    const { cookie } = await login("ada@example.org");
    const me = await pages.inject({
      url: "/nuvenna/api/core/auth/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
  });

  it("rejects wrong password, unknown and inactive accounts alike", async () => {
    for (const [email, password] of [
      ["ada@example.org", "wrong password!"],
      ["nobody@example.org", PASSWORD],
      ["gone@example.org", PASSWORD],
    ] as const) {
      const { res } = await login(email, password);
      expect(res.statusCode, email).toBe(401);
      expect(res.json().error.code).toBe("invalid_credentials");
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
    expect((await track.inject("/tickvana/api/core/auth/me")).statusCode).toBe(
      401,
    );
  });

  it("ends the session on logout and when it expires", async () => {
    const a = await login("ada@example.org");
    await post(
      track,
      "/tickvana/api/core/auth/logout",
      {},
      { cookie: a.cookie },
    );
    expect(
      (
        await track.inject({
          url: "/tickvana/api/core/auth/me",
          headers: { cookie: a.cookie },
        })
      ).statusCode,
    ).toBe(401);

    const b = await login("ada@example.org");
    await t.db
      .updateTable("core_session")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .execute();
    expect(
      (
        await track.inject({
          url: "/tickvana/api/core/auth/me",
          headers: { cookie: b.cookie },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("locks out a user who is deactivated while signed in", async () => {
    const id = await addUser("temp@example.org");
    const { cookie } = await login("temp@example.org");
    await t.db
      .updateTable("core_user")
      .set({ active: false })
      .where("id", "=", id)
      .execute();
    expect(
      (
        await track.inject({
          url: "/tickvana/api/core/auth/me",
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("rejects state-changing cookie requests from other origins", async () => {
    const { cookie } = await login("ada@example.org");
    for (const origin of ["https://evil.example", undefined]) {
      const res = await track.inject({
        method: "POST",
        url: "/tickvana/api/thing",
        payload: {},
        headers: { cookie, ...(origin ? { origin } : {}) },
      });
      expect(res.statusCode, String(origin)).toBe(403);
      expect(res.json().error.code).toBe("bad_origin");
    }
    const ok = await post(track, "/tickvana/api/thing", {}, { cookie });
    expect(ok.json()).toEqual({ by: "ada@example.org" });
  });

  it("authenticates API tokens as bearer, without origin, until revoked or expired", async () => {
    const { cookie } = await login("ada@example.org");
    const created = await post(
      track,
      "/tickvana/api/core/auth/tokens",
      { name: "CI" },
      { cookie },
    );
    expect(created.statusCode).toBe(201);
    const { id, token } = created.json();
    const stored = await t.db
      .selectFrom("core_api_token")
      .select("token_hash")
      .execute();
    expect(stored.map((s) => s.token_hash)).not.toContain(token);

    const bearer = { authorization: `Bearer ${token}` };
    const viaToken = await track.inject({
      method: "POST",
      url: "/tickvana/api/thing",
      payload: {},
      headers: bearer,
    });
    expect(viaToken.json()).toEqual({ by: "ada@example.org" });

    const list = await track.inject({
      url: "/tickvana/api/core/auth/tokens",
      headers: bearer,
    });
    expect(list.json()).toMatchObject([{ id, name: "CI", expiresAt: null }]);
    expect(list.json()[0].lastUsedAt).not.toBeNull();
    expect(JSON.stringify(list.json())).not.toContain(token);

    const bad = await track.inject({
      url: "/tickvana/api/core/auth/me",
      headers: { authorization: "Bearer twk_nope" },
    });
    expect(bad.statusCode).toBe(401);

    await t.db
      .updateTable("core_api_token")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("id", "=", id)
      .execute();
    expect(
      (
        await track.inject({
          url: "/tickvana/api/core/auth/me",
          headers: bearer,
        })
      ).statusCode,
    ).toBe(401);

    await t.db
      .updateTable("core_api_token")
      .set({ expires_at: null })
      .where("id", "=", id)
      .execute();
    const del = await track.inject({
      method: "DELETE",
      url: `/tickvana/api/core/auth/tokens/${id}`,
      headers: bearer,
    });
    expect(del.statusCode).toBe(204);
    expect(
      (
        await track.inject({
          url: "/tickvana/api/core/auth/me",
          headers: bearer,
        })
      ).statusCode,
    ).toBe(401);
  });

  it("resets a password once, ending old sessions", async () => {
    await addUser("reset@example.org");
    const old = await login("reset@example.org");

    resets.length = 0;
    expect(
      (
        await post(track, "/tickvana/api/core/auth/password/forgot", {
          email: "nobody@example.org",
        })
      ).statusCode,
    ).toBe(204);
    expect(resets).toHaveLength(0);
    expect(
      (
        await post(track, "/tickvana/api/core/auth/password/forgot", {
          email: "Reset@example.org",
        })
      ).statusCode,
    ).toBe(204);
    expect(resets).toHaveLength(1);
    const token = resets[0]!;

    const reset = (tok: string, password = "a brand new secret") =>
      post(track, "/tickvana/api/core/auth/password/reset", {
        token: tok,
        password,
      });

    expect((await reset(token.slice(0, -2) + "xx")).statusCode).toBe(400);
    const [userId, , mac] = token.split(".");
    expect(
      (await reset(`${userId}.${Date.now() + 9e9}.${mac}`)).statusCode,
    ).toBe(400);
    expect((await reset(token, "short")).statusCode).toBe(400);

    expect((await reset(token)).statusCode).toBe(204);
    expect(
      (
        await track.inject({
          url: "/tickvana/api/core/auth/me",
          headers: { cookie: old.cookie },
        })
      ).statusCode,
    ).toBe(401);
    expect((await login("reset@example.org")).res.statusCode).toBe(401);
    expect(
      (await login("reset@example.org", "a brand new secret")).res.statusCode,
    ).toBe(200);
    expect((await reset(token, "yet another secret")).statusCode).toBe(400);
  });

  it("limits login attempts per client", async () => {
    const attempt = () =>
      post(strict, "/tickvana/api/core/auth/login", {
        email: "ada@example.org",
        password: "guess guess guess",
      });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await attempt()).statusCode);
    expect(codes).toEqual([401, 401, 401, 429]);
  });
});
