// The one place that decides who may do what. See CONCEPT.md §5.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { AuthUser } from "../auth/store.js";
import { uuidv7 } from "../db/id.js";
import type { CoreDb } from "../schema.js";
import { AppError } from "../server/index.js";

export type GranteeType = CoreDb["core_global_grant"]["grantee_type"];

/**
 * Decides a permission of one scope ("project", "space" …). Registered by the
 * app that owns the scope. `target` is whatever that app's routes pass in.
 */
export type ScopeResolver = (
  user: AuthUser | null,
  permission: string,
  target: unknown,
) => Promise<boolean>;

/**
 * What a route declares in `config.permission`:
 * - "public": no check
 * - "authenticated": any signed-in user
 * - "custom": the handler itself calls `can()` / filters by visible ids
 * - a permission key: checked without target (global permissions)
 * - `{ key, target }`: checked against the target derived from the request
 */
export type RoutePermission =
  | "public"
  | "authenticated"
  | "custom"
  | (string & {})
  | { key: string; target: (req: FastifyRequest) => unknown };

declare module "fastify" {
  interface FastifyContextConfig {
    permission?: RoutePermission;
    /** Open to customers (portal users). Apps decide what that means; Tickvana closes every other route to them. */
    customers?: boolean;
  }
}

/** Passes every check everywhere. */
export const SYSTEM_ADMIN = "system.admin";

export interface Permissions {
  /** Declares a permission key. Scope "global" is decided by core_global_grant. */
  define(key: string, scope: string): void;
  registerScope(scope: string, resolver: ScopeResolver): void;
  can(user: AuthUser | null, key: string, target?: unknown): Promise<boolean>;
  /** Like `can`, but throws 401 for anonymous and 403 for signed-in users. */
  require(user: AuthUser | null, key: string, target?: unknown): Promise<void>;
  /** Ids of the groups a user belongs to, for scope resolvers. */
  groupIds(userId: string): Promise<string[]>;
  keys(scope: string): string[];
}

export function createPermissions(db: Kysely<CoreDb>): Permissions {
  const scopes = new Map<string, ScopeResolver>();
  const defs = new Map<string, string>();

  // ponytail: one query per check. Cache per request if profiles show it.
  const groupIds = async (userId: string) =>
    (
      await db
        .selectFrom("core_group_member")
        .select("group_id")
        .where("user_id", "=", userId)
        .execute()
    ).map((g) => g.group_id);

  async function hasGlobal(
    user: AuthUser | null,
    key: string,
  ): Promise<boolean> {
    const grants = await db
      .selectFrom("core_global_grant")
      .select(["grantee_type", "grantee_id"])
      .where("permission", "=", key)
      .execute();
    if (grants.length === 0) return false;
    if (grants.some((g) => g.grantee_type === "anyone")) return true;
    if (!user) return false;
    // Portal customers are signed in, but "logged_in" means staff.
    if (
      user.kind !== "customer" &&
      grants.some((g) => g.grantee_type === "logged_in")
    )
      return true;
    if (
      grants.some((g) => g.grantee_type === "user" && g.grantee_id === user.id)
    )
      return true;
    const groupGrants = grants.filter((g) => g.grantee_type === "group");
    if (groupGrants.length === 0) return false;
    const mine = new Set(await groupIds(user.id));
    return groupGrants.some(
      (g) => g.grantee_id !== null && mine.has(g.grantee_id),
    );
  }

  const self: Permissions = {
    define(key, scope) {
      if (defs.has(key))
        throw new Error(`Permission "${key}" is already defined`);
      defs.set(key, scope);
    },
    registerScope(scope, resolver) {
      if (scope === "global" || scopes.has(scope))
        throw new Error(`Scope "${scope}" is already registered`);
      scopes.set(scope, resolver);
    },
    async can(user, key, target) {
      const scope = defs.get(key);
      // A typo in a permission key must never read as "allowed".
      if (!scope) throw new Error(`Unknown permission "${key}"`);
      if (user && (await hasGlobal(user, SYSTEM_ADMIN))) return true;
      if (scope === "global") return hasGlobal(user, key);
      const resolver = scopes.get(scope);
      if (!resolver)
        throw new Error(`No resolver for permission scope "${scope}"`);
      return resolver(user, key, target);
    },
    async require(user, key, target) {
      if (await self.can(user, key, target)) return;
      if (!user) throw new AppError(401, "unauthenticated", "Sign in required");
      throw new AppError(
        403,
        "forbidden",
        "You do not have permission to do this",
      );
    },
    groupIds,
    keys: (scope) => [...defs].filter(([, s]) => s === scope).map(([k]) => k),
  };

  self.define(SYSTEM_ADMIN, "global");
  self.define("user.manage", "global");
  self.define("query.sql", "global");
  return self;
}

/**
 * Makes `scope` refuse routes that do not declare `config.permission`, and
 * enforces the declaration before each handler. Needs `req.user`.
 */
export function enforceRoutePermissions(
  scope: FastifyInstance,
  permissions: Permissions,
): void {
  scope.addHook("onRoute", (route) => {
    // HEAD routes are generated from GET routes and share their config.
    if (
      (route.config as { permission?: RoutePermission } | undefined)
        ?.permission === undefined
    ) {
      throw new Error(
        `Route ${String(route.method)} ${route.url} declares no permission`,
      );
    }
  });

  scope.addHook("preHandler", async (req) => {
    const declared = req.routeOptions.config.permission;
    if (
      declared === undefined ||
      declared === "public" ||
      declared === "custom"
    )
      return;
    if (declared === "authenticated") {
      if (!req.user)
        throw new AppError(401, "unauthenticated", "Sign in required");
      return;
    }
    if (typeof declared === "string")
      return permissions.require(req.user, declared);
    return permissions.require(
      req.user,
      declared.key,
      await declared.target(req),
    );
  });
}

export interface GlobalGrant {
  id: string;
  permission: string;
  granteeType: GranteeType;
  granteeId: string | null;
}

export async function listGlobalGrants(
  db: Kysely<CoreDb>,
): Promise<GlobalGrant[]> {
  const rows = await db
    .selectFrom("core_global_grant")
    .selectAll()
    .orderBy("id")
    .execute();
  return rows.map((r) => ({
    id: r.id,
    permission: r.permission,
    granteeType: r.grantee_type,
    granteeId: r.grantee_id,
  }));
}

/** Grants a global permission. Granting the same thing twice returns the existing grant. */
export async function grantGlobal(
  db: Kysely<CoreDb>,
  permission: string,
  granteeType: GranteeType,
  granteeId: string | null = null,
): Promise<string> {
  const needsId = granteeType === "user" || granteeType === "group";
  if (needsId !== (granteeId !== null)) {
    throw new AppError(
      400,
      "validation",
      `Grantee type "${granteeType}" ${needsId ? "needs" : "takes no"} id`,
    );
  }
  if (permission === SYSTEM_ADMIN && !needsId) {
    throw new AppError(
      400,
      "validation",
      "System administration can only be granted to users and groups",
    );
  }
  return db.transaction().execute(async (trx) => {
    let q = trx
      .selectFrom("core_global_grant")
      .select("id")
      .where("permission", "=", permission)
      .where("grantee_type", "=", granteeType);
    q =
      granteeId === null
        ? q.where("grantee_id", "is", null)
        : q.where("grantee_id", "=", granteeId);
    const existing = await q.executeTakeFirst();
    if (existing) return existing.id;
    const id = uuidv7();
    await trx
      .insertInto("core_global_grant")
      .values({
        id,
        permission,
        grantee_type: granteeType,
        grantee_id: granteeId,
        created_at: new Date(),
      })
      .execute();
    return id;
  });
}

export async function revokeGlobal(
  db: Kysely<CoreDb>,
  id: string,
): Promise<void> {
  await db.deleteFrom("core_global_grant").where("id", "=", id).execute();
}

/** Admin API for global permissions, under /core/permissions. */
export async function installPermissionRoutes(
  scope: FastifyInstance,
  db: Kysely<CoreDb>,
  permissions: Permissions,
): Promise<void> {
  const grantSchema = z.object({
    id: z.string(),
    permission: z.string(),
    granteeType: z.enum(["user", "group", "logged_in", "anyone"]),
    granteeId: z.string().nullable(),
  });
  const admin = { permission: SYSTEM_ADMIN };

  await scope.register(
    async (sub) => {
      const r = sub.withTypeProvider<ZodTypeProvider>();

      r.get(
        "/global",
        {
          config: admin,
          schema: {
            response: {
              200: z.object({
                permissions: z.array(z.string()),
                grants: z.array(grantSchema),
              }),
            },
          },
        },
        async () => ({
          permissions: permissions.keys("global"),
          grants: await listGlobalGrants(db),
        }),
      );

      r.post(
        "/global",
        {
          config: admin,
          schema: {
            body: grantSchema.omit({ id: true }),
            response: { 201: z.object({ id: z.string() }) },
          },
        },
        async (req, reply) => {
          const { permission, granteeType, granteeId } = req.body;
          if (!permissions.keys("global").includes(permission)) {
            throw new AppError(
              400,
              "validation",
              `Unknown global permission "${permission}"`,
            );
          }
          const id = await grantGlobal(db, permission, granteeType, granteeId);
          return reply.status(201).send({ id });
        },
      );

      r.delete(
        "/global/:id",
        {
          config: admin,
          schema: {
            params: z.object({ id: z.string() }),
            response: { 204: z.null() },
          },
        },
        async (req, reply) => {
          const grants = await listGlobalGrants(db);
          const target = grants.find((g) => g.id === req.params.id);
          const admins = grants.filter((g) => g.permission === SYSTEM_ADMIN);
          if (target?.permission === SYSTEM_ADMIN && admins.length === 1) {
            throw new AppError(
              409,
              "last_admin",
              "The last system administrator grant cannot be removed",
            );
          }
          await revokeGlobal(db, req.params.id);
          return reply.status(204).send(null);
        },
      );
    },
    { prefix: "/core/permissions" },
  );
}
