// Incoming mail. A job polls each active channel's IMAP folder; every unread
// mail becomes a request of the channel's request type, or a public comment
// when its subject names a ticket of the project. Automatic replies, mailing
// lists and our own mails are skipped, so two systems cannot answer each
// other forever.
import {
  assertPublicHost,
  privateTargetsAllowed,
  resolvePublicHost,
  AppError,
  getMailConfig,
  requireUser,
  uuidv7,
  type AppContext,
  type AuthUser,
  type CoreDb,
} from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ImapFlow } from "imapflow";
import type { Kysely } from "kysely";
import { simpleParser, type ParsedMail } from "mailparser";
import { z } from "zod";
import { issueTarget } from "./access.js";
import type { TrackContext } from "./context.js";
import type { IssueService } from "./issues.js";
import { addComment } from "./routes/issue-parts.js";

/** Job that turns one fetched mail (raw source, base64) into a request or comment. */
export const MAIL_JOB = "track.mail";

const imapSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  user: z.string().min(1).max(255),
  /** Encrypted with SECRET_KEY when stored. */
  password: z.string().max(500),
  folder: z.string().min(1).max(200).default("INBOX"),
});

/** What the inbox needs from a parsed mail. */
export interface IncomingMail {
  from: { address: string; name: string };
  subject: string;
  text: string;
  headers: Map<string, unknown>;
  attachments: { filename: string; contentType: string; content: Buffer }[];
}

export type MailOutcome =
  | { done: "created" | "commented"; key: string }
  | { done: "skipped"; reason: string };

export const fromParsed = (m: ParsedMail): IncomingMail => ({
  from: {
    address: m.from?.value[0]?.address ?? "",
    name: m.from?.value[0]?.name ?? "",
  },
  subject: m.subject ?? "",
  text: m.text ?? "",
  headers: m.headers,
  attachments: m.attachments.map((a) => ({
    filename: a.filename ?? "attachment",
    contentType: a.contentType,
    content: a.content,
  })),
});

/** Why a mail is not from a person, or null when it is. */
export function machineMail(
  mail: IncomingMail,
  ownAddress: string,
): string | null {
  const h = (name: string) =>
    String(mail.headers.get(name) ?? "").toLowerCase();
  const from = mail.from.address.toLowerCase();
  if (!from) return "no sender";
  if (ownAddress && from === ownAddress.toLowerCase()) return "sent by us";
  if (/^(mailer-daemon|postmaster|no-?reply)@/.test(from))
    return "system sender";
  if (h("auto-submitted") && h("auto-submitted") !== "no")
    return "automatic reply";
  if (["bulk", "junk", "list", "auto_reply"].includes(h("precedence")))
    return "bulk mail";
  if (mail.headers.has("x-autoreply") || mail.headers.has("x-autorespond"))
    return "automatic reply";
  if (/\b(all|oof|autoreply)\b/.test(h("x-auto-response-suppress")))
    return "automatic reply";
  // mailparser files List-Id and friends under "list".
  if (mail.headers.has("list") || mail.headers.has("list-id"))
    return "mailing list";
  return null;
}

/** Plain text as a rich-text document; quoted earlier mails are cut off. */
export function textToDoc(text: string, cutQuote: boolean) {
  let body = text.replace(/\r\n/g, "\n");
  if (cutQuote) {
    const lines = body.split("\n");
    const at = lines.findIndex(
      (l) =>
        /^>/.test(l) ||
        /^(On|Am) .+\b(wrote|schrieb)\b.*:\s*$/.test(l) ||
        /^-{2,}\s*(Original|Ursprüngliche)/i.test(l),
    );
    if (at >= 0) body = lines.slice(0, at).join("\n");
  }
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 200);
  return {
    type: "doc",
    content: (paragraphs.length ? paragraphs : ["–"]).map((p) => ({
      type: "paragraph",
      content: [{ type: "text", text: p.slice(0, 20_000) }],
    })),
  };
}

export function createMailInbox(
  ctx: TrackContext,
  app: AppContext,
  issues: IssueService,
) {
  const { db, access } = ctx;
  const core = db as unknown as Kysely<CoreDb>;

  async function sender(
    mail: IncomingMail,
    projectId: string,
  ): Promise<AuthUser> {
    const email = mail.from.address.trim().toLowerCase();
    let row = await db
      .selectFrom("core_user")
      .selectAll()
      .where("email", "=", email)
      .executeTakeFirst();
    if (!row) {
      await app.accounts.create({
        email,
        displayName: mail.from.name.trim().slice(0, 200) || email,
        kind: "customer",
        locale: "de",
        invite: false,
      });
      row = await db
        .selectFrom("core_user")
        .selectAll()
        .where("email", "=", email)
        .executeTakeFirstOrThrow();
    }
    if (!row.active) throw new Error("The sender's account is deactivated");
    // Writing to a channel's address makes a customer of its project.
    if (row.kind === "customer") {
      const known = await db
        .selectFrom("track_project_customer")
        .select("project_id")
        .where("project_id", "=", projectId)
        .where("principal_type", "=", "user")
        .where("principal_id", "=", row.id)
        .executeTakeFirst();
      if (!known)
        await db
          .insertInto("track_project_customer")
          .values({
            project_id: projectId,
            principal_type: "user",
            principal_id: row.id,
          })
          .execute();
    }
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      kind: row.kind,
      locale: row.locale,
      timezone: row.timezone,
    };
  }

  /** Turns one mail into a request or a comment. */
  async function processMail(
    channelId: string,
    mail: IncomingMail,
  ): Promise<MailOutcome> {
    const channel = await db
      .selectFrom("track_mail_channel as c")
      .innerJoin("track_project as p", "p.id", "c.project_id")
      .innerJoin("track_request_type as t", "t.id", "c.request_type_id")
      .select([
        "c.project_id",
        "p.key as project_key",
        "t.id as request_type_id",
        "t.issue_type_id",
        "t.defaults_json",
      ])
      .where("c.id", "=", channelId)
      .executeTakeFirstOrThrow();
    const own =
      (await getMailConfig(core)).from.match(/<([^>]+)>/)?.[1] ??
      (await getMailConfig(core)).from;
    const machine = machineMail(mail, own);
    if (machine) return { done: "skipped", reason: machine };

    const user = await sender(mail, channel.project_id);
    const attach = async (issueId: string) => {
      for (const a of mail.attachments.slice(0, 20))
        await app.attachments
          .store({
            ownerType: "issue",
            ownerId: issueId,
            filename: a.filename,
            mime: a.contentType,
            data: a.content,
            createdBy: user.id,
          })
          .catch(() => undefined); // too large: the mail itself still counts
    };

    // "Re: [WIT-12] …" answers ticket WIT-12 when it belongs to this project.
    const keyMatch = mail.subject.match(
      new RegExp(`\\b(${channel.project_key}-\\d+)\\b`, "i"),
    );
    if (keyMatch) {
      const issue = await db
        .selectFrom("track_issue")
        .selectAll()
        .where("key", "=", keyMatch[1]!.toUpperCase())
        .executeTakeFirst();
      if (
        issue &&
        (await access.can(user, "issue.comment", issueTarget(issue)))
      ) {
        await addComment(
          ctx,
          issues,
          user,
          issue.key,
          textToDoc(mail.text, true),
          "public",
        );
        await attach(issue.id);
        return { done: "commented", key: issue.key };
      }
    }

    const summary =
      mail.subject.replace(/^\s*((re|aw|fwd?|wg)\s*:\s*)+/i, "").trim() ||
      "(ohne Betreff)";
    const made = await issues.create(
      user,
      channel.project_key,
      channel.issue_type_id,
      {
        ...JSON.parse(channel.defaults_json),
        summary: summary.slice(0, 500),
        description: textToDoc(mail.text, false),
      },
      { requestTypeId: channel.request_type_id },
    );
    await attach(made.id);
    return { done: "created", key: made.key };
  }

  /** Reads unread mail of every active channel. */
  async function poll(): Promise<void> {
    const channels = await db
      .selectFrom("track_mail_channel")
      .selectAll()
      .where("active", "=", true)
      .execute();
    const allowPrivate = await privateTargetsAllowed(core);
    for (const c of channels) {
      const imap = imapSchema.parse(JSON.parse(c.imap_json));
      // The same rule as for webhooks: no servers in private networks unless
      // allowed. Connect to the very address checked, the name only for TLS.
      let address: string;
      try {
        address = await resolvePublicHost(imap.host, allowPrivate);
      } catch {
        continue;
      }
      const client = new ImapFlow({
        host: address,
        servername: imap.host,
        port: imap.port,
        secure: imap.secure,
        auth: { user: imap.user, pass: app.secrets.decrypt(imap.password) },
        logger: false,
      });
      try {
        await client.connect();
        const lock = await client.getMailboxLock(imap.folder);
        try {
          const unseen =
            (await client.search({ seen: false }, { uid: true })) || [];
          // ponytail: 50 mails a round per channel; the next round takes the rest.
          for (const uid of unseen.slice(0, 50)) {
            const msg = await client.fetchOne(
              String(uid),
              { source: true },
              { uid: true },
            );
            if (!msg || !msg.source) continue;
            // Handed to a job (retried on failure), then marked read: no mail is lost or read twice.
            await app.queue.enqueue(core, MAIL_JOB, {
              channelId: c.id,
              source: msg.source.toString("base64"),
            });
            await client.messageFlagsAdd(String(uid), ["\\Seen"], {
              uid: true,
            });
          }
        } finally {
          lock.release();
        }
      } finally {
        await client.logout().catch(() => undefined);
      }
    }
  }

  app.queue.job(MAIL_JOB, async (payload) => {
    const { channelId, source } = payload as {
      channelId: string;
      source: string;
    };
    await processMail(
      channelId,
      fromParsed(await simpleParser(Buffer.from(source, "base64"))),
    );
  });
  app.queue.every("track-mail-inbox", 60_000, poll);
  return { processMail, poll };
}

export type MailInbox = ReturnType<typeof createMailInbox>;

// --- Routes ---------------------------------------------------------------------------

export async function mailChannelRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
  app: AppContext,
): Promise<void> {
  const { db } = ctx;
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const custom = { permission: "custom" as const };
  const body = z.object({
    requestTypeId: z.string(),
    /** Leave the password empty to keep the stored one. */
    imap: imapSchema,
    active: z.boolean().default(true),
  });
  const out = z.object({
    id: z.string(),
    requestTypeId: z.string(),
    imap: imapSchema
      .omit({ password: true })
      .extend({ hasPassword: z.boolean() }),
    active: z.boolean(),
  });
  const present = (c: {
    id: string;
    request_type_id: string;
    imap_json: string;
    active: boolean;
  }) => {
    const { password, ...imap } = imapSchema.parse(JSON.parse(c.imap_json));
    return {
      id: c.id,
      requestTypeId: c.request_type_id,
      imap: { ...imap, hasPassword: password !== "" },
      active: Boolean(c.active),
    };
  };
  async function check(projectId: string, requestTypeId: string) {
    const t = await db
      .selectFrom("track_request_type")
      .select("id")
      .where("id", "=", requestTypeId)
      .where("project_id", "=", projectId)
      .executeTakeFirst();
    if (!t)
      throw new AppError(
        400,
        "validation",
        "Choose a request type of this project",
      );
  }
  /** Refuses mail servers in private networks, as for webhooks. */
  async function publicHost(host: string) {
    try {
      await assertPublicHost(
        host,
        await privateTargetsAllowed(db as unknown as Kysely<CoreDb>),
      );
    } catch (e) {
      // A name that does not resolve yet is fine to store; polling skips it.
      if ((e as Error).message.includes("private network"))
        throw new AppError(400, "validation", (e as Error).message);
    }
  }
  const keyParam = z.object({ key: z.string().max(10) });

  r.get(
    "/projects/:key/mail-channels",
    {
      config: custom,
      schema: { params: keyParam, response: { 200: z.array(out) } },
    },
    async (req) => {
      const project = await ctx.project(
        requireUser(req),
        req.params.key,
        "project.administer",
      );
      return (
        await db
          .selectFrom("track_mail_channel")
          .selectAll()
          .where("project_id", "=", project.id)
          .execute()
      ).map(present);
    },
  );
  r.post(
    "/projects/:key/mail-channels",
    {
      config: custom,
      schema: { params: keyParam, body, response: { 201: out } },
    },
    async (req, reply) => {
      const project = await ctx.project(
        requireUser(req),
        req.params.key,
        "project.administer",
      );
      await check(project.id, req.body.requestTypeId);
      await publicHost(req.body.imap.host);
      const row = {
        id: uuidv7(),
        project_id: project.id,
        request_type_id: req.body.requestTypeId,
        imap_json: JSON.stringify({
          ...req.body.imap,
          password: app.secrets.encrypt(req.body.imap.password),
        }),
        active: req.body.active,
      };
      await db.insertInto("track_mail_channel").values(row).execute();
      return reply.status(201).send(present(row));
    },
  );
  r.put(
    "/mail-channels/:id",
    {
      config: custom,
      schema: {
        params: z.object({ id: z.string() }),
        body,
        response: { 200: out },
      },
    },
    async (req) => {
      const row = await db
        .selectFrom("track_mail_channel as c")
        .innerJoin("track_project as p", "p.id", "c.project_id")
        .selectAll("c")
        .select("p.key")
        .where("c.id", "=", req.params.id)
        .executeTakeFirst();
      if (!row) throw new AppError(404, "not_found", "Not found");
      await ctx.project(requireUser(req), row.key, "project.administer");
      await check(row.project_id, req.body.requestTypeId);
      await publicHost(req.body.imap.host);
      const stored = imapSchema.parse(JSON.parse(row.imap_json));
      const next = {
        request_type_id: req.body.requestTypeId,
        imap_json: JSON.stringify({
          ...req.body.imap,
          password: req.body.imap.password
            ? app.secrets.encrypt(req.body.imap.password)
            : stored.password,
        }),
        active: req.body.active,
      };
      await db
        .updateTable("track_mail_channel")
        .set(next)
        .where("id", "=", row.id)
        .execute();
      return present({ ...row, ...next });
    },
  );
  r.delete(
    "/mail-channels/:id",
    { config: custom, schema: { params: z.object({ id: z.string() }) } },
    async (req, reply) => {
      const row = await db
        .selectFrom("track_mail_channel as c")
        .innerJoin("track_project as p", "p.id", "c.project_id")
        .select(["c.id", "p.key"])
        .where("c.id", "=", req.params.id)
        .executeTakeFirst();
      if (!row) throw new AppError(404, "not_found", "Not found");
      await ctx.project(requireUser(req), row.key, "project.administer");
      await db
        .deleteFrom("track_mail_channel")
        .where("id", "=", row.id)
        .execute();
      return reply.status(204).send(null);
    },
  );
}
