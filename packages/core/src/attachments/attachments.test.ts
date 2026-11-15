import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { installAuth } from "../auth/routes.js";
import { createApiToken } from "../auth/store.js";
import { uuidv7 } from "../db/index.js";
import { migrateCore } from "../migrations/index.js";
import { createPermissions } from "../permissions/index.js";
import type { CoreDb } from "../schema.js";
import { createServer } from "../server/index.js";
import { describeEachDb } from "../testing/index.js";
import { installAttachments } from "./index.js";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);
const URL_BASE = "/t/api/core/attachments";
const OWNER = "?ownerType=issue&ownerId=i1";

describeEachDb<CoreDb>("attachments", (t) => {
  let app: FastifyInstance;
  const storagePath = mkdtempSync(join(tmpdir(), "tw-files-"));
  const bearer: Record<string, { authorization: string }> = {};
  const ids: Record<string, string> = {};

  const storedFiles = () =>
    readdirSync(storagePath, { recursive: true, withFileTypes: true }).filter(
      (e) => e.isFile(),
    ).length;

  beforeAll(async () => {
    await migrateCore(t);
    for (const name of ["writer", "reader", "stranger"]) {
      const now = new Date();
      ids[name] = uuidv7();
      await t.db
        .insertInto("core_user")
        .values({
          id: ids[name],
          email: `${name}@example.org`,
          display_name: name,
          password_hash: null,
          kind: "internal",
          active: true,
          locale: "de",
          timezone: "UTC",
          created_at: now,
          updated_at: now,
        })
        .execute();
      bearer[name] = {
        authorization: `Bearer ${(await createApiToken(t.db, ids[name], "t", null)).token}`,
      };
    }
    app = await createServer({
      name: "t",
      version: "0",
      prefix: "/t",
      routes: async (scope) => {
        await installAuth(scope, {
          db: t.db,
          permissions: createPermissions(t.db),
          baseUrl: "http://localhost",
          secretKey: "s".repeat(32),
          sendPasswordReset: async () => {},
        });
        const attachments = await installAttachments(scope, {
          db: t.db,
          storagePath,
          maxBytes: 1000,
        });
        // Stand-in for Tickvana: issue i1, writer may change it, reader may look.
        attachments.registerOwner("issue", {
          canRead: async (user, id) =>
            id === "i1" &&
            ["writer", "reader"].includes(user?.displayName ?? ""),
          canWrite: async (user, id) =>
            id === "i1" && user.displayName === "writer",
        });
      },
    });
  });

  afterAll(() => app?.close());

  const upload = async (
    as: string | null,
    name: string,
    type: string,
    bytes: Buffer,
    query = OWNER,
  ) => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type }), name);
    const body = new Response(form);
    return app.inject({
      method: "POST",
      url: URL_BASE + query,
      payload: Buffer.from(await body.arrayBuffer()),
      headers: {
        "content-type": body.headers.get("content-type")!,
        ...(as ? bearer[as] : { origin: "http://localhost" }),
      },
    });
  };
  const get = (url: string, as?: string) =>
    app.inject({ url: URL_BASE + url, headers: as ? bearer[as] : {} });

  it("stores an upload and serves it back to readers with safe headers", async () => {
    const before = storedFiles();
    const res = await upload(
      "writer",
      "..\\..\\Foto März.png",
      "image/png",
      PNG,
    );
    expect(res.statusCode).toBe(201);
    const meta = res.json();
    expect(meta).toMatchObject({
      filename: "Foto März.png",
      mime: "image/png",
      size: PNG.length,
      createdBy: ids.writer,
    });
    expect(storedFiles()).toBe(before + 1);

    const file = await get(`/${meta.id}`, "reader");
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(PNG)).toBe(true);
    expect(file.headers["content-type"]).toBe("image/png");
    expect(file.headers["x-content-type-options"]).toBe("nosniff");
    expect(file.headers["content-security-policy"]).toContain("sandbox");
    expect(file.headers["content-disposition"]).toBe(
      "inline; filename*=UTF-8''Foto%20M%C3%A4rz.png",
    );

    expect(
      (await get(OWNER, "reader")).json().map((a: { id: string }) => a.id),
    ).toContain(meta.id);
  });

  it("never serves disguised or active content inline", async () => {
    const html = Buffer.from("<script>alert(1)</script>");
    const fake = (await upload("writer", "bild.png", "image/png", html)).json();
    expect(fake.mime).toBe("application/octet-stream");
    const page = (
      await upload("writer", "seite.html", "text/html", html)
    ).json();
    const svg = (
      await upload(
        "writer",
        "x.svg",
        "image/svg+xml",
        Buffer.from("<svg onload='x'/>"),
      )
    ).json();
    for (const meta of [fake, page, svg]) {
      const res = await get(`/${meta.id}`, "writer");
      expect(res.headers["content-disposition"], meta.filename).toMatch(
        /^attachment;/,
      );
    }
  });

  it("checks access through the owner", async () => {
    const meta = (
      await upload("writer", "a.txt", "text/plain", Buffer.from("geheim"))
    ).json();

    expect(
      (await upload("reader", "b.txt", "text/plain", Buffer.from("x")))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await upload(
          "writer",
          "b.txt",
          "text/plain",
          Buffer.from("x"),
          "?ownerType=issue&ownerId=i2",
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await upload(
          "writer",
          "b.txt",
          "text/plain",
          Buffer.from("x"),
          "?ownerType=nope&ownerId=i1",
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (await upload(null, "b.txt", "text/plain", Buffer.from("x"))).statusCode,
    ).toBe(401);

    expect((await get(`/${meta.id}`, "stranger")).statusCode).toBe(403);
    expect((await get(`/${meta.id}`)).statusCode).toBe(401);
    expect((await get(OWNER, "stranger")).statusCode).toBe(403);
    expect((await get(`/${uuidv7()}`, "writer")).statusCode).toBe(404);

    const del = (as: string) =>
      app.inject({
        method: "DELETE",
        url: `${URL_BASE}/${meta.id}`,
        headers: bearer[as],
      });
    expect((await del("reader")).statusCode).toBe(403);
    const before = storedFiles();
    expect((await del("writer")).statusCode).toBe(204);
    expect(storedFiles()).toBe(before - 1);
    expect((await get(`/${meta.id}`, "writer")).statusCode).toBe(404);
  });

  it("rejects files over the limit and leaves nothing behind", async () => {
    const before = storedFiles();
    const rows = await t.db
      .selectFrom("core_attachment")
      .select("id")
      .execute();
    const res = await upload(
      "writer",
      "gross.bin",
      "application/octet-stream",
      Buffer.alloc(1001),
    );
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("too_large");
    expect(storedFiles()).toBe(before);
    expect(
      await t.db.selectFrom("core_attachment").select("id").execute(),
    ).toHaveLength(rows.length);
    expect(existsSync(storagePath)).toBe(true);
    expect(
      (
        await upload(
          "writer",
          "passt.bin",
          "application/octet-stream",
          Buffer.alloc(1000),
        )
      ).statusCode,
    ).toBe(201);
  });
});
