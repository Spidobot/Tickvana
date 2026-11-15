// Passwords, sessions, API tokens and password-reset tokens. No HTTP in here.
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import type { Kysely } from "kysely";
import { uuidv7 } from "../db/id.js";
import type { CoreDb } from "../schema.js";

type Db = Kysely<CoreDb>;

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  kind: CoreDb["core_user"]["kind"];
  locale: string;
  timezone: string;
}

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const RESET_MS = 60 * 60 * 1000;
const API_TOKEN_PREFIX = "twk_";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const randomToken = () => randomBytes(32).toString("base64url");

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** argon2id with the library defaults. */
export const hashPassword = (password: string) => hash(password);

// Verified when the account does not exist or has no password, so that a wrong
// e-mail costs the same time as a wrong password.
const dummyHash = hash(randomToken());

const toAuthUser = (u: CoreDb["core_user"]): AuthUser => ({
  id: u.id,
  email: u.email,
  displayName: u.display_name,
  kind: u.kind,
  locale: u.locale,
  timezone: u.timezone,
});

async function activeUser(db: Db, id: string): Promise<AuthUser | null> {
  const u = await db
    .selectFrom("core_user")
    .selectAll()
    .where("id", "=", id)
    .where("active", "=", true)
    .executeTakeFirst();
  return u ? toAuthUser(u) : null;
}

/** Returns the user when e-mail and password match an active account. */
export async function checkPassword(
  db: Db,
  email: string,
  password: string,
): Promise<AuthUser | null> {
  const u = await db
    .selectFrom("core_user")
    .selectAll()
    .where("email", "=", normalizeEmail(email))
    .executeTakeFirst();
  const ok = await verify(
    u?.password_hash ?? (await dummyHash),
    password,
  ).catch(() => false);
  return u && u.password_hash && u.active && ok ? toAuthUser(u) : null;
}

/** Creates a session and returns the cookie value. Only its hash is stored. */
export async function createSession(
  db: Db,
  userId: string,
  now = new Date(),
): Promise<string> {
  const token = randomToken();
  await db
    .insertInto("core_session")
    .values({
      id_hash: sha256(token),
      user_id: userId,
      expires_at: new Date(now.getTime() + SESSION_MS),
      created_at: now,
    })
    .execute();
  return token;
}

export async function resolveSession(
  db: Db,
  token: string,
  now = new Date(),
): Promise<AuthUser | null> {
  const idHash = sha256(token);
  const s = await db
    .selectFrom("core_session")
    .selectAll()
    .where("id_hash", "=", idHash)
    .where("expires_at", ">", now)
    .executeTakeFirst();
  if (!s) return null;
  // Sliding expiry, written at most once a day per session.
  if (
    s.expires_at.getTime() - now.getTime() <
    SESSION_MS - 24 * 60 * 60 * 1000
  ) {
    await db
      .updateTable("core_session")
      .set({ expires_at: new Date(now.getTime() + SESSION_MS) })
      .where("id_hash", "=", idHash)
      .execute();
  }
  return activeUser(db, s.user_id);
}

export async function destroySession(db: Db, token: string): Promise<void> {
  await db
    .deleteFrom("core_session")
    .where("id_hash", "=", sha256(token))
    .execute();
}

export async function destroyUserSessions(
  db: Db,
  userId: string,
): Promise<void> {
  await db.deleteFrom("core_session").where("user_id", "=", userId).execute();
}

/** Creates an API token. The returned `token` is shown once and never stored. */
export async function createApiToken(
  db: Db,
  userId: string,
  name: string,
  expiresAt: Date | null,
  now = new Date(),
): Promise<{ id: string; token: string }> {
  const id = uuidv7();
  const token = API_TOKEN_PREFIX + randomToken();
  await db
    .insertInto("core_api_token")
    .values({
      id,
      token_hash: sha256(token),
      user_id: userId,
      name,
      expires_at: expiresAt,
      last_used_at: null,
      created_at: now,
    })
    .execute();
  return { id, token };
}

export async function resolveApiToken(
  db: Db,
  token: string,
  now = new Date(),
): Promise<AuthUser | null> {
  if (!token.startsWith(API_TOKEN_PREFIX)) return null;
  const t = await db
    .selectFrom("core_api_token")
    .selectAll()
    .where("token_hash", "=", sha256(token))
    .executeTakeFirst();
  if (!t || (t.expires_at && t.expires_at <= now)) return null;
  // Written at most once a minute per token.
  if (!t.last_used_at || now.getTime() - t.last_used_at.getTime() > 60_000) {
    await db
      .updateTable("core_api_token")
      .set({ last_used_at: now })
      .where("id", "=", t.id)
      .execute();
  }
  return activeUser(db, t.user_id);
}

// Reset tokens are stateless: `<userId>.<expiryMs>.<hmac>`. The HMAC covers the
// current password hash, so a token dies as soon as the password changes.
function resetMac(
  secret: string,
  userId: string,
  expiry: string,
  passwordHash: string | null,
): Buffer {
  return createHmac("sha256", secret)
    .update(`reset\n${userId}\n${expiry}\n${passwordHash ?? ""}`)
    .digest();
}

/** Returns a reset token for an active account, or null when there is none. */
export async function createResetToken(
  db: Db,
  secret: string,
  email: string,
  now = new Date(),
  ttlMs = RESET_MS,
): Promise<{ user: AuthUser; token: string } | null> {
  const u = await db
    .selectFrom("core_user")
    .selectAll()
    .where("email", "=", normalizeEmail(email))
    .where("active", "=", true)
    .executeTakeFirst();
  if (!u) return null;
  const expiry = String(now.getTime() + ttlMs);
  const mac = resetMac(secret, u.id, expiry, u.password_hash).toString(
    "base64url",
  );
  return { user: toAuthUser(u), token: `${u.id}.${expiry}.${mac}` };
}

/** Sets a new password and ends all sessions. False when the token is invalid or expired. */
export async function resetPassword(
  db: Db,
  secret: string,
  token: string,
  newPassword: string,
  now = new Date(),
): Promise<boolean> {
  const [userId, expiry, mac] = token.split(".");
  if (!userId || !expiry || !mac || !(Number(expiry) > now.getTime()))
    return false;
  const u = await db
    .selectFrom("core_user")
    .select(["id", "password_hash"])
    .where("id", "=", userId)
    .where("active", "=", true)
    .executeTakeFirst();
  if (!u) return false;
  const given = Buffer.from(mac, "base64url");
  const expected = resetMac(secret, u.id, expiry, u.password_hash);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return false;

  const passwordHash = await hashPassword(newPassword);
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("core_user")
      .set({ password_hash: passwordHash, updated_at: now })
      .where("id", "=", u.id)
      .execute();
    await trx.deleteFrom("core_session").where("user_id", "=", u.id).execute();
  });
  return true;
}
