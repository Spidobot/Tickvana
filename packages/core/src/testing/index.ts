import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, inject } from "vitest";
import { createDb, type Database } from "../db/index.js";

export interface TestDatabase<DB> extends Database<DB> {
  /** URL of this file's private database, for opening further connections. */
  readonly url: string;
}

/**
 * Runs a test block once per database server under test. Every call gets a
 * fresh, empty database that is dropped afterwards, so test files never see
 * each other's tables.
 *
 * `t.db`, `t.dialect` and `t.url` exist from `beforeAll` on: use them inside
 * hooks and tests, not in the describe body.
 */
export function describeEachDb<DB>(
  name: string,
  fn: (t: TestDatabase<DB>) => void,
): void {
  const servers = inject("dbUrls").map(
    (url) => [new URL(url).protocol.slice(0, -1), url] as const,
  );

  describe.each(servers)(`%s: ${name}`, (_label, adminUrl) => {
    const t = {} as {
      -readonly [K in keyof TestDatabase<DB>]: TestDatabase<DB>[K];
    };
    const dbName = `tw_${randomBytes(6).toString("hex")}`;

    beforeAll(async () => {
      const admin = createDb<unknown>(adminUrl);
      try {
        await sql`create database ${sql.id(dbName)}`.execute(admin.db);
      } finally {
        await admin.db.destroy();
      }
      const url = new URL(adminUrl);
      url.pathname = `/${dbName}`;
      Object.assign(t, createDb<DB>(url.href), { url: url.href });
    });

    afterAll(async () => {
      await t.db?.destroy();
      const admin = createDb<unknown>(adminUrl);
      try {
        await sql`drop database if exists ${sql.id(dbName)}`.execute(admin.db);
      } finally {
        await admin.db.destroy();
      }
    });

    fn(t);
  });
}
