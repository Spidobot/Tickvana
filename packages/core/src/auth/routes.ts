import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { CoreDb } from "../schema.js";
import { AppError } from "../server/index.js";
import {
  enforceRoutePermissions,
  type Permissions,
} from "../permissions/index.js";
import { getOidcConfig, installOidcRoutes } from "./oidc.js";
import {
  checkPassword,
  createApiToken,
  createResetToken,
  createSession,
  destroySession,
  resetPassword,
  resolveApiToken,
  resolveSession,
  type AuthUser,
} from "./store.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The signed-in user, or null. Set for every route below the auth scope. */
    user: AuthUser | null;
  }
}

export interface AuthOptions {
  db: Kysely<CoreDb>;
  permissions: Permissions;
  /** Public address, e.g. https://work.example.org. Decides the allowed Origin and the Secure flag. */
  baseUrl: string;
  secretKey: string;
  /** Delivers the reset link. Mail arrives with F-11. */
  sendPasswordReset: (user: AuthUser, token: string) => Promise<void>;
  /** Attempts per minute and client address on login and reset routes. */
  rateLimitMax?: number;
}

const COOKIE = "tvn_session";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  kind: z.enum(["internal", "customer", "service"]),
  locale: z.string(),
  timezone: z.string(),
});
const password = z.string().min(10).max(200);

/** Use in handlers that need a signed-in user. */
export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw new AppError(401, "unauthenticated", "Sign in required");
  return req.user;
}

/** Like requireUser, but portal customers are turned away: staff tools only. */
export function requireStaff(req: FastifyRequest): AuthUser {
  const user = requireUser(req);
  if (user.kind === "customer")
    throw new AppError(
      403,
      "forbidden",
      "You do not have permission to do this",
    );
  return user;
}

/**
 * Adds authentication to `scope` and everything registered in it afterwards:
 * `req.user` from the session cookie or a bearer token, the same-origin check
 * for cookie requests, and the routes under /core/auth.
 */
export async function installAuth(
  scope: FastifyInstance,
  opts: AuthOptions,
): Promise<{ setSessionCookie: (reply: FastifyReply, token: string) => void }> {
  const { db } = opts;
  const origin = new URL(opts.baseUrl).origin;
  const cookieOptions = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: origin.startsWith("https:"),
  };

  const setSessionCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(COOKIE, token, {
      ...cookieOptions,
      maxAge: 30 * 24 * 60 * 60,
    });

  await scope.register(cookie);
  await scope.register(rateLimit, { global: false });
  scope.decorateRequest("user", null);

  scope.addHook("onRequest", async (req) => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (bearer) {
      req.user = await resolveApiToken(db, bearer);
      if (!req.user)
        throw new AppError(
          401,
          "invalid_token",
          "Invalid or expired API token",
        );
      return;
    }
    // Cookies travel with cross-site requests, tokens do not. So everything
    // without a token that can change state must come from our own origin.
    if (!SAFE_METHODS.has(req.method) && req.headers.origin !== origin) {
      throw new AppError(403, "bad_origin", "Cross-origin request rejected");
    }
    const session = req.cookies[COOKIE];
    req.user = session ? await resolveSession(db, session) : null;
  });

  enforceRoutePermissions(scope, opts.permissions);

  // ponytail: counted in memory per process and per client address. Move to a
  // shared store if several web containers run, add a per-account limit if
  // distributed guessing shows up.
  const limited = {
    permission: "public" as const,
    rateLimit: { max: opts.rateLimitMax ?? 10, timeWindow: "1 minute" },
  };

  await scope.register(
    async (auth) => {
      const r = auth.withTypeProvider<ZodTypeProvider>();

      r.post(
        "/login",
        {
          config: limited,
          schema: {
            body: z.object({
              email: z.string().max(320),
              password: z.string().max(200),
            }),
            response: { 200: userSchema },
          },
        },
        async (req, reply) => {
          const user = await checkPassword(
            db,
            req.body.email,
            req.body.password,
          );
          if (!user)
            throw new AppError(
              401,
              "invalid_credentials",
              "E-mail or password is wrong",
            );
          setSessionCookie(reply, await createSession(db, user.id));
          return user;
        },
      );

      // What the login page offers.
      r.get(
        "/providers",
        {
          config: { permission: "public" as const },
          schema: {
            response: {
              200: z.object({
                password: z.boolean(),
                oidc: z
                  .object({ label: z.string(), autoRedirect: z.boolean() })
                  .nullable(),
              }),
            },
          },
        },
        async () => {
          const oidc = await getOidcConfig(db);
          return {
            password: true,
            oidc: oidc.enabled
              ? { label: oidc.label, autoRedirect: oidc.autoRedirect }
              : null,
          };
        },
      );

      await installOidcRoutes(auth, {
        db,
        origin,
        secretKey: opts.secretKey,
        setSessionCookie,
      });

      r.post(
        "/logout",
        {
          config: { permission: "public" as const },
          schema: { response: { 204: z.null() } },
        },
        async (req, reply) => {
          const session = req.cookies[COOKIE];
          if (session) await destroySession(db, session);
          reply.clearCookie(COOKIE, cookieOptions);
          return reply.status(204).send(null);
        },
      );

      r.get(
        "/me",
        {
          config: { permission: "authenticated" as const },
          schema: { response: { 200: userSchema } },
        },
        async (req) => requireUser(req),
      );

      r.post(
        "/password/forgot",
        {
          config: limited,
          schema: {
            body: z.object({ email: z.string().max(320) }),
            response: { 204: z.null() },
          },
        },
        async (req, reply) => {
          // Same answer whether or not the account exists.
          const reset = await createResetToken(
            db,
            opts.secretKey,
            req.body.email,
          );
          if (reset) await opts.sendPasswordReset(reset.user, reset.token);
          return reply.status(204).send(null);
        },
      );

      r.post(
        "/password/reset",
        {
          config: limited,
          schema: {
            body: z.object({ token: z.string().max(500), password }),
            response: { 204: z.null() },
          },
        },
        async (req, reply) => {
          const ok = await resetPassword(
            db,
            opts.secretKey,
            req.body.token,
            req.body.password,
          );
          if (!ok)
            throw new AppError(
              400,
              "invalid_reset_token",
              "Reset link is invalid or expired",
            );
          return reply.status(204).send(null);
        },
      );

      const tokenSchema = z.object({
        id: z.string(),
        name: z.string(),
        expiresAt: z.iso.datetime().nullable(),
        lastUsedAt: z.iso.datetime().nullable(),
        createdAt: z.iso.datetime(),
      });

      r.get(
        "/tokens",
        {
          config: { permission: "authenticated" as const },
          schema: { response: { 200: z.array(tokenSchema) } },
        },
        async (req) => {
          const rows = await db
            .selectFrom("core_api_token")
            .selectAll()
            .where("user_id", "=", requireUser(req).id)
            .orderBy("created_at")
            .execute();
          return rows.map((t) => ({
            id: t.id,
            name: t.name,
            expiresAt: t.expires_at?.toISOString() ?? null,
            lastUsedAt: t.last_used_at?.toISOString() ?? null,
            createdAt: t.created_at.toISOString(),
          }));
        },
      );

      r.post(
        "/tokens",
        {
          config: { permission: "authenticated" as const },
          schema: {
            body: z.object({
              name: z.string().trim().min(1).max(200),
              expiresAt: z.iso.datetime().nullable().default(null),
            }),
            response: { 201: z.object({ id: z.string(), token: z.string() }) },
          },
        },
        async (req, reply) => {
          const created = await createApiToken(
            db,
            requireUser(req).id,
            req.body.name,
            req.body.expiresAt ? new Date(req.body.expiresAt) : null,
          );
          return reply.status(201).send(created);
        },
      );

      r.delete(
        "/tokens/:id",
        {
          config: { permission: "authenticated" as const },
          schema: {
            params: z.object({ id: z.string() }),
            response: { 204: z.null() },
          },
        },
        async (req, reply) => {
          await db
            .deleteFrom("core_api_token")
            .where("id", "=", req.params.id)
            .where("user_id", "=", requireUser(req).id)
            .execute();
          return reply.status(204).send(null);
        },
      );
    },
    { prefix: "/core/auth" },
  );
  return { setSessionCookie };
}
