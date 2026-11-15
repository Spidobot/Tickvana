// Test helper: the real Tickvana app on a fresh database, plus users with API tokens.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApiToken,
  createDb,
  grantGlobal,
  startApp,
  SYSTEM_ADMIN,
  uuidv7,
  type CoreDb,
  type RunningApp,
} from "@tvn/core";
import { sql, type Kysely } from "kysely";
import { definition } from "./app.js";
import type { TrackDb } from "./db/schema.js";

/** The parts of an injected response the tests read. */
export interface TestResponse {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): any;
}

export interface TestApp {
  running: RunningApp;
  /** Connection URL of the read-only role, when the app was started with one. */
  queryUrl?: string;
  db: Kysely<TrackDb>;
  /** User ids by name. */
  ids: Record<string, string>;
  /** Calls the API as a user (or anonymously with `null`). Paths are relative to /tickvana/api. */
  call(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    as: string | null,
    payload?: object,
  ): Promise<TestResponse>;
  addUser(
    name: string,
    options?: { admin?: boolean; kind?: CoreDb["core_user"]["kind"] },
  ): Promise<string>;
  close(): Promise<void>;
}

export interface TestAppOptions {
  /**
   * Create a database role that can only log in, and run the query engine
   * through it, like DB_QUERY_URL in production.
   */
  queryRole?: boolean;
  queryTimeoutMs?: number;
}

/** Creates a login-only database role and returns a connection URL for it. */
async function createQueryRole(dbUrl: string): Promise<string> {
  const admin = createDb<unknown>(dbUrl);
  const role = `tw_q_${randomBytes(5).toString("hex")}`;
  const password = randomBytes(12).toString("hex");
  try {
    if (admin.dialect.name === "postgres") {
      await sql`create role ${sql.id(role)} login password ${sql.lit(password)}`.execute(
        admin.db,
      );
    } else {
      await sql`create user ${sql.lit(role)}@${sql.lit("%")} identified by ${sql.lit(password)}`.execute(
        admin.db,
      );
    }
  } finally {
    await admin.db.destroy();
  }
  const url = new URL(dbUrl);
  url.username = role;
  url.password = password;
  return url.href;
}

export async function startTestApp(
  dbUrl: string,
  options: TestAppOptions = {},
): Promise<TestApp> {
  const queryUrl = options.queryRole ? await createQueryRole(dbUrl) : undefined;
  const running = await startApp(definition, {
    DB_URL: dbUrl,
    PORT: 0,
    BASE_URL: "http://localhost",
    SECRET_KEY: "t".repeat(32),
    TRUST_PROXY: false,
    ROLE: "web",
    STORAGE_PATH: mkdtempSync(join(tmpdir(), "tvn-tickvana-")),
    MAX_UPLOAD_MB: 5,
    DB_QUERY_URL: queryUrl,
    QUERY_TIMEOUT_MS: options.queryTimeoutMs ?? 15_000,
    QUERY_RATE_PER_MINUTE: 100_000,
  });
  const core = running.database.db;
  const ids: Record<string, string> = {};
  const tokens: Record<string, string> = {};

  return {
    running,
    queryUrl,
    db: core as unknown as Kysely<TrackDb>,
    ids,
    async addUser(name, { admin = false, kind = "internal" } = {}) {
      const now = new Date();
      const id = uuidv7();
      await core
        .insertInto("core_user")
        .values({
          id,
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
      if (admin) await grantGlobal(core, SYSTEM_ADMIN, "user", id);
      ids[name] = id;
      tokens[name] = (await createApiToken(core, id, "test", null)).token;
      return id;
    },
    call: async (method, url, as, payload) =>
      running.server.inject({
        method,
        url: `/tickvana/api${url}`,
        payload,
        headers: as
          ? { authorization: `Bearer ${tokens[as]}` }
          : { origin: "http://localhost" },
      }),
    close: () => running.close(),
  };
}
