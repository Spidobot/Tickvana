import { expect, it } from "vitest";
import type { CoreDb } from "../schema.js";
import { describeEachDb } from "../testing/index.js";
import { loadConfig, startApp } from "./start.js";

it("names every configuration problem", () => {
  expect(() => loadConfig({ PORT: "99999" })).toThrow(
    /DB_URL[\s\S]*PORT|PORT[\s\S]*DB_URL/,
  );
  expect(
    loadConfig({
      DB_URL: "postgres://u:p@h/d",
      BASE_URL: "http://localhost",
      SECRET_KEY: "x".repeat(32),
    }).PORT,
  ).toBe(3000);
});

describeEachDb<CoreDb>("startApp", (t) => {
  it("migrates, listens, and reports the database in health", async () => {
    const app = await startApp(
      {
        name: "track",
        version: "0.0.0",
        prefix: "/tickvana",
        routes: () => async () => {},
      },
      {
        DB_URL: t.url,
        PORT: 0,
        BASE_URL: "http://localhost",
        SECRET_KEY: "x".repeat(32),
        TRUST_PROXY: false,
        STORAGE_PATH: "/data",
        MAX_UPLOAD_MB: 50,
        ROLE: "web",
      },
    );
    try {
      const address = app.server.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const up = await fetch(`http://127.0.0.1:${port}/tickvana/api/health`);
      expect(up.status).toBe(200);
      expect(
        await app.database.db.selectFrom("core_user").selectAll().execute(),
      ).toEqual([]);

      await app.database.db.destroy();
      const down = await fetch(`http://127.0.0.1:${port}/tickvana/api/health`);
      expect(down.status).toBe(503);
    } finally {
      await app.server.close();
    }
  });

  it("as worker runs jobs without listening", async () => {
    let ran = 0;
    const app = await startApp(
      {
        name: "track",
        version: "0.0.0",
        prefix: "/tickvana",
        routes: ({ queue }) => {
          queue.job("ping", async () => void ran++);
          return async () => {};
        },
      },
      {
        DB_URL: t.url,
        PORT: 0,
        BASE_URL: "http://localhost",
        SECRET_KEY: "x".repeat(32),
        TRUST_PROXY: false,
        STORAGE_PATH: "/data",
        MAX_UPLOAD_MB: 50,
        ROLE: "worker",
      },
    );
    try {
      expect(app.server.server.listening).toBe(false);
      await app.queue.enqueue(app.database.db, "ping", {});
      await expect.poll(() => ran, { timeout: 10_000 }).toBe(1);
    } finally {
      await app.close();
    }
  });
});
