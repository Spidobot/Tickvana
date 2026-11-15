import { createHmac } from "node:crypto";
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
} from "fastify";
import type { Kysely } from "kysely";
import { z } from "zod";
import {
  installAttachments,
  type Attachments,
  type AttachmentOwner,
  storeAttachment,
} from "../attachments/index.js";
import { installAuth } from "../auth/routes.js";
import { decryptSecret, encryptSecret } from "../settings.js";
import {
  createResetToken,
  createSession,
  hashPassword,
  normalizeEmail,
} from "../auth/store.js";
import { uuidv7 } from "../db/id.js";
import {
  createPermissions,
  installPermissionRoutes,
  type Permissions,
} from "../permissions/index.js";
import {
  installBrandingRoutes,
  type BrandDefaults,
} from "../branding/index.js";
import { createDb, ping, type Database } from "../db/index.js";
import { createMailer, installMailRoutes, type Mailer } from "../mail/index.js";
import { installSystemRoutes } from "../system/index.js";
import { migrateCore } from "../migrations/index.js";
import {
  createNotifier,
  installNotificationRoutes,
  type Notifier,
} from "../notifications/index.js";
import {
  createQueryEngine,
  installQueryRoutes,
  groupsTable,
  usersTable,
  type SavedQueries,
  type QueryEngine,
} from "../query/index.js";
import { installSavedQueries } from "../query/saved.js";
import { installDashboards } from "../query/dashboards.js";
import { createQueue, type Queue } from "../queue/index.js";
import type { CoreDb } from "../schema.js";
import { installUserRoutes } from "../users/index.js";
import {
  installWebhookDelivery,
  installWebhookRoutes,
} from "../webhooks/index.js";
import { AppError, createServer } from "./index.js";

const configSchema = z.object({
  DB_URL: z.url(),
  /** Public address of the installation, e.g. https://work.example.org */
  BASE_URL: z.url(),
  /** Signs reset links and encrypts stored credentials. */
  SECRET_KEY: z.string().min(32),
  /** Set to true behind Caddy or another reverse proxy. */
  TRUST_PROXY: z.stringbool().default(false),
  /** all: API and background jobs in one process. web / worker: only one of them. */
  ROLE: z.enum(["all", "web", "worker"]).default("all"),
  /** Where attachments are stored. Mount a volume here. */
  STORAGE_PATH: z.string().default("/data"),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(50),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  /** Directory of the built web app. Unset in API-only setups and tests. */
  WEB_ROOT: z.string().optional(),
  /**
   * Connection for the SQL query engine, with a database role that can only
   * read. Without it, queries run on the main connection and only system
   * administrators may write them.
   */
  DB_QUERY_URL: z.url().optional(),
  /** Queries of the SQL engine are stopped after this many milliseconds. */
  QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000),
  /** SQL statements a client may run per minute. */
  QUERY_RATE_PER_MINUTE: z.coerce.number().int().min(1).default(60),
});
export type Config = z.infer<typeof configSchema>;
/** The settings without a default, plus any others to override. */
export type StartConfig = Pick<Config, "DB_URL" | "BASE_URL" | "SECRET_KEY"> &
  Partial<Config>;

/** Reads and validates the start-up variables. Fails with all problems at once. */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export interface AppDefinition {
  name: string;
  version: string;
  prefix: string;
  /** Product name and accent colour until an administrator sets a brand. */
  brand?: BrandDefaults;
  /** Receives the open database so routes can close over it. */
  routes: (ctx: AppContext) => FastifyPluginAsync;
  /** App-specific migrations, run after the core ones. */
  migrate?: (database: Database<CoreDb>) => Promise<unknown>;
}

/** What an app gets to build its routes from. */
export interface AppContext {
  database: Database<CoreDb>;
  permissions: Permissions;
  /** Events and background jobs. Register subscribers and job handlers while building routes. */
  queue: Queue;
  /** Register who may read and write attachments of your entity types. */
  attachments: Attachments;
  mailer: Mailer;
  /** The SQL query engine. Register your virtual tables while building routes. */
  query: QueryEngine;
  /** Saved queries: load and run one with a user's rights. For boards, queues and widgets. */
  savedQueries: SavedQueries;
  /** Tell users about events, and register how your events read. */
  notifier: Notifier;
  /** Accounts for flows outside the admin pages, such as portal sign-up. */
  accounts: Accounts;
  /** Encrypts stored credentials with SECRET_KEY. */
  secrets: {
    encrypt(plain: string): string;
    decrypt(stored: string): string;
    /** HMAC of a value, for links that must not be forged. */
    sign(value: string): string;
  };
  /** Public address of this app, e.g. https://work.example.org/tickvana */
  baseUrl: string;
}

export interface Accounts {
  /**
   * Creates an active account. Without a password, mails a link to choose
   * one (valid seven days). Throws 409 when the address is taken.
   */
  create(input: {
    email: string;
    displayName: string;
    kind: "internal" | "customer";
    locale: string;
    password?: string;
    /** Named in the invitation mail. */
    invitedBy?: string;
    /** false: no mail; the person can still set a password through "forgot password". */
    invite?: boolean;
  }): Promise<string>;
  /** Starts a session for the user and sets its cookie on the reply. */
  signIn(reply: FastifyReply, userId: string): Promise<void>;
}

export interface RunningApp {
  server: FastifyInstance;
  database: Database<CoreDb>;
  queue: Queue;
  notifier: Notifier;
  savedQueries: SavedQueries;
  close: () => Promise<void>;
}

/** Opens the database, migrates, and listens. Shared by Tickvana and Nuvenna. */
export async function startApp(
  def: AppDefinition,
  /** Defaults to the environment. Tests pass the required settings plus what they want to change. */
  given: StartConfig = loadConfig(),
  /** Build the server without touching the database or the network. For the API description. */
  offline = false,
): Promise<RunningApp> {
  const { DB_URL, BASE_URL, SECRET_KEY } = given;
  const config: Config = {
    ...loadConfig({ DB_URL, BASE_URL, SECRET_KEY }),
    ...given,
  };
  const database = createDb<CoreDb>(config.DB_URL);
  try {
    if (!offline) {
      await migrateCore(database);
      await def.migrate?.(database);
    }
    const permissions = createPermissions(database.db);
    const queue = createQueue(database.db, {
      onError: (error, job) =>
        server?.log.error({ err: error, job }, "job failed"),
    });
    const brand = def.brand ?? { productName: def.name, accent: "#4f6bff" };
    const mailer = createMailer(database.db, config.SECRET_KEY, queue, brand);
    installWebhookDelivery({
      db: database.db,
      queue,
      secretKey: config.SECRET_KEY,
    });
    const setPasswordUrl = (token: string) =>
      `${new URL(config.BASE_URL).origin}${def.prefix}/reset-password?token=${encodeURIComponent(token)}`;
    const queryDb = config.DB_QUERY_URL
      ? createDb<unknown>(config.DB_QUERY_URL)
      : undefined;
    const query = createQueryEngine({
      db: (queryDb ?? database).db as Kysely<unknown>,
      dialect: database.dialect,
      permissions,
      isolated: queryDb !== undefined,
      timeoutMs: config.QUERY_TIMEOUT_MS,
    });
    query.register(usersTable(database.db));
    query.register(groupsTable(database.db));
    // Routes are installed later; apps get a handle that works once they are.
    const saved: { current?: SavedQueries } = {};
    const notifier = createNotifier(database.db, queue, mailer, {
      secretKey: config.SECRET_KEY,
      origin: new URL(config.BASE_URL).origin,
      apiBase: `${def.prefix}/api`,
    });
    // Owners are registered while routes are built, the routes that use them come later.
    const owners: [string, AttachmentOwner][] = [];
    const cookie: { set?: (reply: FastifyReply, token: string) => void } = {};
    const accounts: Accounts = {
      async create(input) {
        const now = new Date();
        const row: CoreDb["core_user"] = {
          id: uuidv7(),
          email: normalizeEmail(input.email),
          display_name: input.displayName,
          password_hash: input.password
            ? await hashPassword(input.password)
            : null,
          kind: input.kind,
          active: true,
          locale: input.locale,
          timezone: "UTC",
          created_at: now,
          updated_at: now,
        };
        await database.db.transaction().execute(async (trx) => {
          const taken = await trx
            .selectFrom("core_user")
            .select("id")
            .where("email", "=", row.email)
            .executeTakeFirst();
          if (taken)
            throw new AppError(
              409,
              "conflict",
              "This e-mail address is already in use",
            );
          await trx.insertInto("core_user").values(row).execute();
          await queue.emit(trx, {
            type: "user.created",
            actorId: null,
            entityType: "user",
            entityId: row.id,
          });
        });
        if (!input.password && input.invite !== false) {
          const invite = await createResetToken(
            database.db,
            config.SECRET_KEY,
            row.email,
            now,
            7 * 24 * 3600_000,
          );
          const de = row.locale.startsWith("de");
          const by = input.invitedBy;
          await mailer.send(database.db, {
            to: row.email,
            subject: de
              ? "Dein Zugang ist eingerichtet"
              : "Your access is ready",
            body: [
              de
                ? `${by ? `${by} hat` : "Wir haben"} einen Zugang für dich angelegt. Der Link gilt sieben Tage.`
                : `${by ? `${by} created` : "We created"} an account for you. The link is valid for seven days.`,
            ],
            action: {
              label: de ? "Passwort festlegen" : "Choose a password",
              url: setPasswordUrl(invite!.token),
            },
          });
        }
        return row.id;
      },
      async signIn(reply, userId) {
        cookie.set!(reply, await createSession(database.db, userId));
      },
    };
    const appRoutes = def.routes({
      accounts,
      secrets: {
        encrypt: (plain) => encryptSecret(config.SECRET_KEY, plain),
        decrypt: (stored) => decryptSecret(config.SECRET_KEY, stored),
        sign: (value) =>
          createHmac("sha256", config.SECRET_KEY)
            .update(value)
            .digest("base64url"),
      },
      baseUrl: `${new URL(config.BASE_URL).origin}${def.prefix}`,
      database,
      permissions,
      queue,
      mailer,
      notifier,
      query,
      savedQueries: {
        load: (...args) => saved.current!.load(...args),
        run: (...args) => saved.current!.run(...args),
        sendSubscriptions: (...args) =>
          saved.current!.sendSubscriptions(...args),
      },
      attachments: {
        registerOwner: (type, owner) => void owners.push([type, owner]),
        store: (input) =>
          storeAttachment(
            {
              db: database.db,
              storagePath: config.STORAGE_PATH,
              maxBytes: config.MAX_UPLOAD_MB * 1024 * 1024,
            },
            input,
          ),
      },
    });
    const server: FastifyInstance = await createServer({
      name: def.name,
      version: def.version,
      prefix: def.prefix,
      routes: async (scope) => {
        const { setSessionCookie } = await installAuth(scope, {
          db: database.db,
          permissions,
          baseUrl: config.BASE_URL,
          secretKey: config.SECRET_KEY,
          sendPasswordReset: (user, token) => {
            const de = user.locale.startsWith("de");
            return mailer.send(database.db, {
              to: user.email,
              subject: de ? "Passwort zurücksetzen" : "Reset your password",
              body: [
                de
                  ? "Für dein Konto wurde ein neues Passwort angefordert. Der Link gilt eine Stunde."
                  : "A new password was requested for your account. The link is valid for one hour.",
                de
                  ? "Wenn du das nicht warst, kannst du diese Nachricht ignorieren."
                  : "If this was not you, you can ignore this message.",
              ],
              action: {
                label: de ? "Neues Passwort setzen" : "Set a new password",
                url: setPasswordUrl(token),
              },
            });
          },
        });
        cookie.set = setSessionCookie;
        await installPermissionRoutes(scope, database.db, permissions);
        await installMailRoutes(scope, database.db, config.SECRET_KEY, mailer);
        await installSystemRoutes(scope, {
          db: database.db,
          secretKey: config.SECRET_KEY,
        });
        await installNotificationRoutes(scope, database.db, notifier);
        await installWebhookRoutes(scope, {
          db: database.db,
          queue,
          secretKey: config.SECRET_KEY,
        });
        await installQueryRoutes(scope, query, config.QUERY_RATE_PER_MINUTE);
        saved.current = await installSavedQueries(scope, {
          db: database.db,
          engine: query,
          permissions,
          queue,
          mailer,
          queryUrl: (id) =>
            `${new URL(config.BASE_URL).origin}${def.prefix}/queries/${id}`,
        });
        await installDashboards(scope, {
          db: database.db,
          permissions,
          saved: () => saved.current!,
        });
        await installUserRoutes(scope, {
          db: database.db,
          permissions,
          queue,
          mailer,
          secretKey: config.SECRET_KEY,
          setPasswordUrl,
        });
        const attachments = await installAttachments(scope, {
          db: database.db,
          storagePath: config.STORAGE_PATH,
          maxBytes: config.MAX_UPLOAD_MB * 1024 * 1024,
        });
        for (const [type, owner] of owners)
          attachments.registerOwner(type, owner);
        await installBrandingRoutes(scope, {
          db: database.db,
          permissions,
          attachments,
          apiBase: `${def.prefix}/api`,
          defaults: brand,
          setSessionCookie,
        });
        await scope.register(appRoutes);
      },
      trustProxy: config.TRUST_PROXY,
      webRoot: config.WEB_ROOT,
      ready: () => ping(database.db),
      logger: process.env.NODE_ENV !== "test",
    });
    await server.ready();
    if (config.DB_QUERY_URL && !offline) {
      // The read-only role may read exactly what the virtual tables need.
      const role = decodeURIComponent(new URL(config.DB_QUERY_URL).username);
      try {
        for (const g of query.grants())
          await database.dialect.grantSelect(
            database.db,
            role,
            g.table,
            g.columns,
          );
      } catch (error) {
        server.log.warn(
          { err: error, role, grants: query.grants() },
          "could not grant the query role its tables: grant SELECT on the listed tables by hand",
        );
      }
    }
    if (!offline) {
      if (config.ROLE !== "worker")
        await server.listen({ port: config.PORT, host: "0.0.0.0" });
      if (config.ROLE !== "web") await queue.start();
    }
    const close = async () => {
      await queue.stop();
      await queryDb?.db.destroy();
      await server.close();
      await database.db.destroy();
    };
    return {
      server,
      database,
      queue,
      notifier,
      savedQueries: saved.current!,
      close,
    };
  } catch (err) {
    await database.db.destroy();
    throw err;
  }
}

/** Entry point for a container: start, and shut down cleanly on SIGTERM/SIGINT. */
export async function runApp(def: AppDefinition): Promise<void> {
  const app = await startApp(def);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => void app.close().then(() => process.exit(0)));
  }
}

/** The OpenAPI document of an app, for generating the web client. Needs no database. */
export async function openApiSpec(def: AppDefinition): Promise<object> {
  const app = await startApp(
    def,
    loadConfig({
      // Never connected to: nothing queries in offline mode.
      DB_URL: "postgres://offline:offline@127.0.0.1:1/offline",
      BASE_URL: "http://localhost",
      SECRET_KEY: "offline".repeat(5),
    }),
    true,
  );
  try {
    return app.server.swagger();
  } finally {
    await app.close();
  }
}
