// Key/value settings in core_setting, plus encryption for secrets stored there.
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type { Kysely } from "kysely";
import type { z } from "zod";
import type { CoreDb } from "./schema.js";

/** Reads a setting and validates it. Missing or invalid values yield the schema's defaults. */
export async function getSetting<S extends z.ZodType>(
  db: Kysely<CoreDb>,
  key: string,
  schema: S,
): Promise<z.infer<S>> {
  const row = await db
    .selectFrom("core_setting")
    .select("value_json")
    .where("key", "=", key)
    .executeTakeFirst();
  const stored = schema.safeParse(row ? JSON.parse(row.value_json) : {});
  return stored.success ? stored.data : schema.parse({});
}

export async function setSetting(
  db: Kysely<CoreDb>,
  key: string,
  value: unknown,
): Promise<void> {
  // Delete + insert: the one upsert that reads the same on every database.
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("core_setting").where("key", "=", key).execute();
    await trx
      .insertInto("core_setting")
      .values({
        key,
        value_json: JSON.stringify(value),
        updated_at: new Date(),
      })
      .execute();
  });
}

const aesKey = (secretKey: string) =>
  Buffer.from(hkdfSync("sha256", secretKey, "", "tvn-setting-secret", 32));

/** AES-256-GCM with a key derived from SECRET_KEY. Output: `v1.<iv>.<tag>.<data>`. */
export function encryptSecret(secretKey: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey(secretKey), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), data]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

/** Throws when the value was tampered with or SECRET_KEY changed. */
export function decryptSecret(secretKey: string, encrypted: string): string {
  const [version, iv, tag, data] = encrypted.split(".");
  if (version !== "v1" || !iv || !tag || data === undefined) {
    throw new Error("Unknown secret format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    aesKey(secretKey),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
