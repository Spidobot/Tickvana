import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { AppError, createServer } from "./index.js";

let app: FastifyInstance;
let dbUp = true;

beforeAll(async () => {
  const webRoot = mkdtempSync(join(tmpdir(), "tw-web-"));
  writeFileSync(
    join(webRoot, "index.html"),
    "<!doctype html><title>shell</title>",
  );
  writeFileSync(join(webRoot, "app.js"), "console.log(1)");

  app = await createServer({
    name: "track",
    version: "1.2.3",
    prefix: "/tickvana",
    webRoot,
    ready: async () => {
      if (!dbUp) throw new Error("connection refused at 10.0.0.5");
    },
    routes: async (scope) => {
      const r = scope.withTypeProvider<ZodTypeProvider>();
      r.post(
        "/echo",
        {
          schema: {
            body: z.object({ n: z.number().int() }),
            response: { 200: z.object({ n: z.number() }) },
          },
        },
        async (req) => ({ n: req.body.n }),
      );
      r.get("/teapot", async () => {
        throw new AppError(418, "teapot", "No coffee", { hint: "tea" });
      });
      r.get("/boom", async () => {
        throw new Error("password=hunter2");
      });
    },
  });
  await app.ready();
});

afterAll(() => app.close());

it("reports health with a request id of its own", async () => {
  const res = await app.inject({
    url: "/tickvana/api/health",
    headers: { "x-request-id": "spoofed" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: "ok", app: "track", version: "1.2.3" });
  expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  // Hardening headers on every answer.
  expect(res.headers["content-security-policy"]).toContain(
    "frame-ancestors 'self'",
  );
  expect(res.headers["content-security-policy"]).toContain(
    "script-src 'self';",
  );
  expect(res.headers["x-content-type-options"]).toBe("nosniff");
  expect(res.headers["referrer-policy"]).toBe("same-origin");
});

it("answers 503 without details when a dependency is down", async () => {
  dbUp = false;
  const res = await app.inject("/tickvana/api/health");
  dbUp = true;
  expect(res.statusCode).toBe(503);
  expect(res.body).not.toContain("10.0.0.5");
  expect(res.json().error.code).toBe("unavailable");
});

it("validates input and uses one error format", async () => {
  const ok = await app.inject({
    method: "POST",
    url: "/tickvana/api/echo",
    payload: { n: 2 },
  });
  expect(ok.json()).toEqual({ n: 2 });

  const bad = await app.inject({
    method: "POST",
    url: "/tickvana/api/echo",
    payload: { n: "x" },
  });
  expect(bad.statusCode).toBe(400);
  const { error } = bad.json();
  expect(error.code).toBe("validation");
  expect(error.details[0].path).toBe("/n");
  expect(error.requestId).toBe(bad.headers["x-request-id"]);

  const malformed = await app.inject({
    method: "POST",
    url: "/tickvana/api/echo",
    payload: "{",
    headers: { "content-type": "application/json" },
  });
  expect(malformed.statusCode).toBe(400);
  expect(malformed.json().error.code).toBe("bad_request");
});

it("passes AppError through and hides everything else", async () => {
  const teapot = await app.inject("/tickvana/api/teapot");
  expect(teapot.statusCode).toBe(418);
  expect(teapot.json().error).toMatchObject({
    code: "teapot",
    message: "No coffee",
    details: { hint: "tea" },
  });

  const boom = await app.inject("/tickvana/api/boom");
  expect(boom.statusCode).toBe(500);
  expect(boom.body).not.toContain("hunter2");
  expect(boom.json().error.code).toBe("internal");
});

it("serves the web app, with index.html for client-side routes", async () => {
  expect((await app.inject("/tickvana/app.js")).body).toContain("console.log");
  const deep = await app.inject("/tickvana/projects/ABC/board");
  expect(deep.statusCode).toBe(200);
  expect(deep.body).toContain("shell");
});

it("answers JSON 404 for unknown API routes and paths outside the app", async () => {
  for (const url of ["/tickvana/api/nope", "/pages/x", "/trackx"]) {
    const res = await app.inject(url);
    expect(res.statusCode, url).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  }
});

it("documents routes as OpenAPI", async () => {
  const res = await app.inject("/tickvana/api/docs/json");
  const doc = res.json();
  expect(doc.info).toEqual({ title: "Track", version: "1.2.3" });
  expect(doc.paths["/tickvana/api/echo"].post.requestBody).toBeDefined();
  expect(doc.paths["/tickvana/api/health"]).toBeDefined();
});
