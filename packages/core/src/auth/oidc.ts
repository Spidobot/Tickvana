import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import * as oidc from "openid-client";
import { z } from "zod";
import { uuidv7 } from "../db/id.js";
import type { CoreDb } from "../schema.js";
import { AppError } from "../server/index.js";
import {
  decryptSecret,
  encryptSecret,
  getSetting,
  setSetting,
} from "../settings.js";
import { createSession, normalizeEmail } from "./store.js";

const SETTING = "auth.oidc";
const PROVIDER = "oidc";
const FLOW_COOKIE = "tvn_oidc";

const storedSchema = z.object({
  enabled: z.boolean().default(false),
  issuer: z.string().default(""),
  clientId: z.string().default(""),
  /** Encrypted with SECRET_KEY. */
  clientSecret: z.string().default(""),
  scopes: z.string().default("openid email profile"),
  /** Text on the login button. */
  label: z.string().default("Single sign-on"),
  /** Create an account on first sign-in. Off: only known e-mail addresses get in. */
  createUsers: z.boolean().default(true),
  /** Send visitors of the login page straight to the provider. `?local=1` still shows the form. */
  autoRedirect: z.boolean().default(false),
  /**
   * Treat the provider's e-mail addresses as verified even without an
   * `email_verified` claim, and fall back to `preferred_username` when no
   * e-mail is sent. Needed for Microsoft Entra ID (M365), which sends neither
   * reliably. Only safe when the provider is your own tenant.
   */
  trustEmail: z.boolean().default(false),
  /**
   * Name of a claim holding a list of group names. When set, the identity
   * provider owns the user's group memberships: they are replaced on every sign-in.
   */
  groupsClaim: z.string().default(""),
});
export type OidcConfig = z.infer<typeof storedSchema>;

/** Stored configuration. `clientSecret` is still encrypted. */
export const getOidcConfig = (db: Kysely<CoreDb>) =>
  getSetting(db, SETTING, storedSchema);

/** Saves the configuration. Pass `clientSecret` in plain text; omit it to keep the stored one. */
export async function setOidcConfig(
  db: Kysely<CoreDb>,
  secretKey: string,
  input: Partial<OidcConfig>,
): Promise<void> {
  const current = await getOidcConfig(db);
  const next = storedSchema.parse({
    ...current,
    ...input,
    clientSecret:
      input.clientSecret === undefined
        ? current.clientSecret
        : encryptSecret(secretKey, input.clientSecret),
  });
  if (next.enabled) new URL(next.issuer); // throws on a missing or malformed issuer
  await setSetting(db, SETTING, next);
}

export interface OidcClaims {
  sub: string;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  [claim: string]: unknown;
}

/**
 * Maps verified ID-token claims to a local user and returns its id.
 * Order: known identity, then an existing account with the same verified
 * e-mail, then a new account.
 */
export async function provisionOidcUser(
  db: Kysely<CoreDb>,
  config: OidcConfig,
  claims: OidcClaims,
  now = new Date(),
): Promise<string> {
  const denied = (message: string) => new AppError(403, "sso_denied", message);

  const userId = await db.transaction().execute(async (trx) => {
    const identity = await trx
      .selectFrom("core_identity")
      .select("user_id")
      .where("provider", "=", PROVIDER)
      .where("subject", "=", claims.sub)
      .executeTakeFirst();
    if (identity) return identity.user_id;

    const claimedEmail =
      typeof claims.email === "string" && claims.email
        ? claims.email
        : config.trustEmail &&
            typeof claims.preferred_username === "string" &&
            claims.preferred_username.includes("@")
          ? claims.preferred_username
          : undefined;
    if (!claimedEmail) {
      throw denied("The identity provider sent no e-mail address");
    }
    const email = normalizeEmail(claimedEmail);
    const existing = await trx
      .selectFrom("core_user")
      .select("id")
      .where("email", "=", email)
      .executeTakeFirst();

    let id = existing?.id;
    if (id) {
      // Linking by an unverified address would let anyone who can register
      // that address at the provider take over the local account.
      if (claims.email_verified !== true && !config.trustEmail) {
        throw denied(
          "An account with this e-mail exists, but the provider has not verified the address",
        );
      }
    } else {
      if (!config.createUsers)
        throw denied("No account exists for this e-mail address");
      id = uuidv7();
      await trx
        .insertInto("core_user")
        .values({
          id,
          email,
          display_name:
            typeof claims.name === "string" && claims.name
              ? claims.name
              : email,
          password_hash: null,
          kind: "internal",
          active: true,
          locale: "en",
          timezone: "UTC",
          created_at: now,
          updated_at: now,
        })
        .execute();
    }
    await trx
      .insertInto("core_identity")
      .values({
        provider: PROVIDER,
        subject: claims.sub,
        user_id: id,
        created_at: now,
      })
      .execute();
    return id;
  });

  const user = await db
    .selectFrom("core_user")
    .select("active")
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  if (!user.active) throw denied("This account is deactivated");

  if (config.groupsClaim) {
    const claimed = claims[config.groupsClaim];
    const names = Array.isArray(claimed)
      ? [
          ...new Set(
            claimed.filter(
              (g): g is string => typeof g === "string" && g.length > 0,
            ),
          ),
        ]
      : [];
    await db.transaction().execute(async (trx) => {
      const known = names.length
        ? await trx
            .selectFrom("core_group")
            .select(["id", "name"])
            .where("name", "in", names)
            .execute()
        : [];
      const ids = new Map(known.map((g) => [g.name, g.id]));
      for (const name of names) {
        if (ids.has(name)) continue;
        const id = uuidv7();
        await trx
          .insertInto("core_group")
          .values({ id, name, created_at: now })
          .execute();
        ids.set(name, id);
      }
      await trx
        .deleteFrom("core_group_member")
        .where("user_id", "=", userId)
        .execute();
      if (ids.size > 0) {
        await trx
          .insertInto("core_group_member")
          .values(
            [...ids.values()].map((group_id) => ({
              group_id,
              user_id: userId,
            })),
          )
          .execute();
      }
    });
  }
  return userId;
}

export interface OidcRouteOptions {
  db: Kysely<CoreDb>;
  /** Origin of the installation, e.g. https://work.example.org */
  origin: string;
  secretKey: string;
  /** Sets the session cookie on the reply. Shared with password login. */
  setSessionCookie: (reply: FastifyReply, token: string) => void;
}

/** A relative path inside this installation, or "/" for anything else. */
function safeReturnTo(value: string | undefined): string {
  return value && /^\/(?![/\\])/.test(value) ? value : "/";
}

/** Registers /oidc/login and /oidc/callback on the auth scope. */
export async function installOidcRoutes(
  auth: FastifyInstance,
  opts: OidcRouteOptions,
): Promise<void> {
  const { db } = opts;
  const secure = opts.origin.startsWith("https:");
  const flowCookie = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
  };
  // e.g. https://work.example.org/tickvana/api/core/auth/oidc/callback
  const redirectUri = `${opts.origin}${auth.prefix}/oidc/callback`;

  // Discovery result, reused until the stored configuration changes.
  let cached: { key: string; client: oidc.Configuration } | undefined;
  async function client(config: OidcConfig): Promise<oidc.Configuration> {
    const key = JSON.stringify(config);
    if (cached?.key === key) return cached.client;
    const issuer = new URL(config.issuer);
    const found = await oidc.discovery(
      issuer,
      config.clientId,
      decryptSecret(opts.secretKey, config.clientSecret),
      undefined,
      // Plain http only when the admin configured an http issuer (lab setups).
      issuer.protocol === "http:"
        ? { execute: [oidc.allowInsecureRequests] }
        : undefined,
    );
    cached = { key, client: found };
    return found;
  }

  async function enabledConfig(): Promise<OidcConfig> {
    const config = await getOidcConfig(db);
    if (!config.enabled)
      throw new AppError(404, "not_found", "Single sign-on is not enabled");
    return config;
  }

  const r = auth.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/oidc/login",
    {
      config: { permission: "public" as const },
      schema: {
        querystring: z.object({ returnTo: z.string().max(2000).optional() }),
      },
    },
    async (req, reply) => {
      const config = await enabledConfig();
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const url = oidc.buildAuthorizationUrl(await client(config), {
        redirect_uri: redirectUri,
        scope: config.scopes,
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
      });
      // The browser carries the flow state. Only the browser that started the
      // flow can finish it, which is what `state` is for.
      reply.setCookie(
        FLOW_COOKIE,
        JSON.stringify({
          verifier,
          state,
          nonce,
          returnTo: safeReturnTo(req.query.returnTo),
        }),
        { ...flowCookie, maxAge: 600 },
      );
      return reply.redirect(url.href);
    },
  );

  r.get(
    "/oidc/callback",
    { config: { permission: "public" as const } },
    async (req, reply) => {
      const config = await enabledConfig();
      const flow = z
        .object({
          verifier: z.string(),
          state: z.string(),
          nonce: z.string(),
          returnTo: z.string(),
        })
        .safeParse(JSON.parse(req.cookies[FLOW_COOKIE] || "null"));
      reply.clearCookie(FLOW_COOKIE, flowCookie);
      if (!flow.success)
        throw new AppError(400, "sso_failed", "Sign-in expired. Start again");

      let claims: OidcClaims | undefined;
      try {
        const tokens = await oidc.authorizationCodeGrant(
          await client(config),
          new URL(req.url, opts.origin),
          {
            pkceCodeVerifier: flow.data.verifier,
            expectedState: flow.data.state,
            expectedNonce: flow.data.nonce,
          },
        );
        claims = tokens.claims() as OidcClaims | undefined;
      } catch (cause) {
        req.log.warn(cause, "oidc code exchange failed");
      }
      if (!claims)
        throw new AppError(
          400,
          "sso_failed",
          "Sign-in at the identity provider failed",
        );

      const userId = await provisionOidcUser(db, config, claims);
      opts.setSessionCookie(reply, await createSession(db, userId));
      return reply.redirect(safeReturnTo(flow.data.returnTo));
    },
  );
}
