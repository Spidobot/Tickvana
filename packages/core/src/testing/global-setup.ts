// Vitest global setup: one PostgreSQL and one MariaDB server for the whole run.
// Test files create their own database on them through `describeEachDb`.
import { MariaDbContainer } from "@testcontainers/mariadb";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** Admin connection URLs, one per database server under test. */
    dbUrls: string[];
  }
}

const servers: Record<
  string,
  () => Promise<{ url: string; stop: () => Promise<unknown> }>
> = {
  async postgres() {
    const c = await new PostgreSqlContainer("postgres:16").start();
    return { url: c.getConnectionUri(), stop: () => c.stop() };
  },
  async mariadb() {
    const c = await new MariaDbContainer("mariadb:11").start();
    // Root, because tests create and drop databases.
    const url = `mysql://root:${c.getRootPassword()}@${c.getHost()}:${c.getPort()}/${c.getDatabase()}`;
    return { url, stop: () => c.stop() };
  },
};

export default async function setup(project: TestProject) {
  // TEST_DB_URLS: use servers that already run (no Docker needed).
  const given = (process.env.TEST_DB_URLS ?? "").split(",").filter(Boolean);
  if (given.length > 0) {
    project.provide("dbUrls", given);
    return;
  }

  // TEST_DBS: subset to start, e.g. "postgres". CI runs one per matrix job.
  const names = (process.env.TEST_DBS ?? "postgres,mariadb")
    .split(",")
    .filter(Boolean);
  const started = await Promise.all(
    names.map((name) => {
      const start = servers[name];
      if (!start)
        throw new Error(
          `Unknown TEST_DBS entry "${name}". Known: ${Object.keys(servers).join(", ")}`,
        );
      return start();
    }),
  );
  project.provide(
    "dbUrls",
    started.map((s) => s.url),
  );
  return async () => {
    await Promise.all(started.map((s) => s.stop()));
  };
}
