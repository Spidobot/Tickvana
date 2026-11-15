// File attachments: streamed to disk under STORAGE_PATH, served with the
// permissions of the thing they hang on (an issue, a page …).
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import { requireUser } from "../auth/routes.js";
import type { AuthUser } from "../auth/store.js";
import { uuidv7 } from "../db/id.js";
import type { CoreDb } from "../schema.js";
import { AppError } from "../server/index.js";

/** Decides access for one owner type. Registered by the app that owns it. */
export interface AttachmentOwner {
  canRead(user: AuthUser | null, ownerId: string): Promise<boolean>;
  canWrite(user: AuthUser, ownerId: string): Promise<boolean>;
}

export interface Attachments {
  registerOwner(type: string, owner: AttachmentOwner): void;
  /** Stores a file that did not come through the upload route, e.g. from an incoming mail. */
  store(input: StoreInput): Promise<string>;
}

export interface StoreInput {
  ownerType: string;
  ownerId: string;
  filename: string;
  mime: string;
  data: Buffer;
  createdBy: string;
}

/** Writes the file under STORAGE_PATH and records it. Images keep their type only when their bytes match it. */
export async function storeAttachment(
  opts: AttachmentOptions,
  input: StoreInput,
): Promise<string> {
  if (input.data.length > opts.maxBytes)
    throw new AppError(
      413,
      "too_large",
      `File exceeds the limit of ${opts.maxBytes} bytes`,
    );
  const id = uuidv7();
  const now = new Date();
  const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${id}`;
  const path = join(opts.storagePath, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, input.data, { flag: "wx" });
  const head = input.data.subarray(0, 12);
  const mime = INLINE.get(input.mime)?.(head)
    ? input.mime
    : INLINE.has(input.mime)
      ? "application/octet-stream"
      : input.mime.slice(0, 200);
  try {
    await opts.db
      .insertInto("core_attachment")
      .values({
        id,
        owner_type: input.ownerType,
        owner_id: input.ownerId,
        filename: cleanFilename(input.filename),
        mime,
        size: input.data.length,
        storage_key: key,
        created_by: input.createdBy,
        created_at: now,
      })
      .execute();
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
  return id;
}

export interface AttachmentOptions {
  db: Kysely<CoreDb>;
  storagePath: string;
  maxBytes: number;
}

// Shown in the browser. Everything else downloads. SVG is left out on purpose: it can run script.
const INLINE = new Map<string, (head: Buffer) => boolean>([
  [
    "image/png",
    (h) => h.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
  ],
  ["image/jpeg", (h) => h.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))],
  [
    "image/gif",
    (h) => ["GIF87a", "GIF89a"].includes(h.subarray(0, 6).toString("latin1")),
  ],
  [
    "image/webp",
    (h) =>
      h.subarray(0, 4).toString("latin1") === "RIFF" &&
      h.subarray(8, 12).toString("latin1") === "WEBP",
  ],
]);

/** Keeps the last path segment and drops control characters. */
function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = [...base]
    .filter((c) => c >= " " && c !== "")
    .join("")
    .trim()
    .slice(0, 255);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "file";
}

const metaSchema = z.object({
  id: z.string(),
  ownerType: z.string(),
  ownerId: z.string(),
  filename: z.string(),
  mime: z.string(),
  size: z.number(),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
});

const toMeta = (a: CoreDb["core_attachment"]): z.infer<typeof metaSchema> => ({
  id: a.id,
  ownerType: a.owner_type,
  ownerId: a.owner_id,
  filename: a.filename,
  mime: a.mime,
  size: a.size,
  createdBy: a.created_by,
  createdAt: a.created_at.toISOString(),
});

/** Registers the routes under /core/attachments and returns the owner registry. */
export async function installAttachments(
  scope: FastifyInstance,
  opts: AttachmentOptions,
): Promise<Attachments> {
  const { db } = opts;
  const owners = new Map<string, AttachmentOwner>();
  const ownerOf = (type: string) => {
    const owner = owners.get(type);
    if (!owner)
      throw new AppError(
        400,
        "validation",
        `Unknown attachment owner type "${type}"`,
      );
    return owner;
  };
  const forbidden = () =>
    new AppError(403, "forbidden", "You do not have permission to do this");
  // The handlers check access through the owner, hence "custom".
  const config = { permission: "custom" as const };
  const ownerQuery = z.object({
    ownerType: z.string().max(50),
    ownerId: z.string().max(36),
  });

  await scope.register(
    async (sub) => {
      await sub.register(multipart, {
        limits: { fileSize: opts.maxBytes, files: 1, fields: 0 },
      });
      const r = sub.withTypeProvider<ZodTypeProvider>();

      const load = async (id: string) => {
        const a = await db
          .selectFrom("core_attachment")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirst();
        if (!a) throw new AppError(404, "not_found", "Not found");
        return a;
      };

      r.post(
        "/",
        {
          config,
          schema: { querystring: ownerQuery, response: { 201: metaSchema } },
        },
        async (req, reply) => {
          const user = requireUser(req);
          const { ownerType, ownerId } = req.query;
          if (!(await ownerOf(ownerType).canWrite(user, ownerId)))
            throw forbidden();

          const file = await req.file();
          if (!file)
            throw new AppError(
              400,
              "validation",
              "Send one file as multipart/form-data",
            );

          const id = uuidv7();
          const now = new Date();
          const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${id}`;
          const path = join(opts.storagePath, key);
          await mkdir(dirname(path), { recursive: true });

          let size = 0;
          file.file.on("data", (chunk: Buffer) => (size += chunk.length));
          try {
            await pipeline(file.file, createWriteStream(path, { flags: "wx" }));
            if (file.file.truncated) {
              throw new AppError(
                413,
                "too_large",
                `File exceeds the limit of ${opts.maxBytes} bytes`,
              );
            }
            // The declared type decides nothing: only bytes that really are an
            // image keep an image type.
            const handle = await open(path, "r");
            const head = Buffer.alloc(12);
            await handle.read(head, 0, 12, 0).finally(() => handle.close());
            const mime = INLINE.get(file.mimetype)?.(head)
              ? file.mimetype
              : INLINE.has(file.mimetype)
                ? "application/octet-stream"
                : file.mimetype.slice(0, 200);

            const row: CoreDb["core_attachment"] = {
              id,
              owner_type: ownerType,
              owner_id: ownerId,
              filename: cleanFilename(file.filename),
              mime,
              size,
              storage_key: key,
              created_by: user.id,
              created_at: now,
            };
            await db.insertInto("core_attachment").values(row).execute();
            return await reply.status(201).send(toMeta(row));
          } catch (error) {
            await rm(path, { force: true });
            throw error;
          }
        },
      );

      r.get(
        "/",
        {
          config,
          schema: {
            querystring: ownerQuery,
            response: { 200: z.array(metaSchema) },
          },
        },
        async (req) => {
          const { ownerType, ownerId } = req.query;
          if (!(await ownerOf(ownerType).canRead(req.user, ownerId))) {
            throw req.user
              ? forbidden()
              : new AppError(401, "unauthenticated", "Sign in required");
          }
          const rows = await db
            .selectFrom("core_attachment")
            .selectAll()
            .where("owner_type", "=", ownerType)
            .where("owner_id", "=", ownerId)
            .orderBy("id")
            .execute();
          return rows.map(toMeta);
        },
      );

      r.get(
        "/:id",
        { config, schema: { params: z.object({ id: z.string() }) } },
        async (req, reply) => {
          const a = await load(req.params.id);
          if (!(await ownerOf(a.owner_type).canRead(req.user, a.owner_id))) {
            throw req.user
              ? forbidden()
              : new AppError(401, "unauthenticated", "Sign in required");
          }
          const inline = INLINE.has(a.mime);
          return (
            reply
              .header("content-type", a.mime)
              .header("content-length", a.size)
              .header("x-content-type-options", "nosniff")
              // Even if a browser renders the file, it runs nothing and loads nothing.
              .header("content-security-policy", "sandbox; default-src 'none'")
              .header("cache-control", "private, max-age=3600")
              .header(
                "content-disposition",
                `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
              )
              .send(createReadStream(join(opts.storagePath, a.storage_key)))
          );
        },
      );

      r.delete(
        "/:id",
        {
          config,
          schema: {
            params: z.object({ id: z.string() }),
            response: { 204: z.null() },
          },
        },
        async (req, reply) => {
          const user = requireUser(req);
          const a = await load(req.params.id);
          if (!(await ownerOf(a.owner_type).canWrite(user, a.owner_id)))
            throw forbidden();
          await db
            .deleteFrom("core_attachment")
            .where("id", "=", a.id)
            .execute();
          await rm(join(opts.storagePath, a.storage_key), { force: true });
          return reply.status(204).send(null);
        },
      );
    },
    { prefix: "/core/attachments" },
  );

  return {
    store: (input) => storeAttachment(opts, input),
    registerOwner(type, owner) {
      if (owners.has(type))
        throw new Error(
          `Attachment owner type "${type}" is already registered`,
        );
      owners.set(type, owner);
    },
  };
}
