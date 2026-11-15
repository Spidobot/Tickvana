// Outgoing mail: SMTP settings in core_setting, delivery as a background job.
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { createTransport, type Transporter } from "nodemailer";
import { z } from "zod";
import { SYSTEM_ADMIN } from "../permissions/index.js";
import type { Queue } from "../queue/index.js";
import type { CoreDb } from "../schema.js";
import { AppError } from "../server/index.js";
import {
  decryptSecret,
  encryptSecret,
  getSetting,
  setSetting,
} from "../settings.js";

const SETTING = "mail.smtp";
const JOB = "mail.send";

const storedSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().default(""),
  port: z.number().int().min(1).max(65535).default(587),
  /** true: TLS from the first byte (port 465). false: STARTTLS when the server offers it. */
  secure: z.boolean().default(false),
  user: z.string().default(""),
  /** Encrypted with SECRET_KEY. */
  password: z.string().default(""),
  /** e.g. `Tickvana <no-reply@example.org>` */
  from: z.string().default(""),
});
export type MailConfig = z.infer<typeof storedSchema>;

// For partial updates. Deliberately without defaults: a default would overwrite
// every field the caller left out.
const inputSchema = z
  .object({
    enabled: z.boolean(),
    host: z.string().max(255),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    user: z.string().max(255),
    password: z.string().max(500),
    from: z.string().max(320),
  })
  .partial();

export const getMailConfig = (db: Kysely<CoreDb>) =>
  getSetting(db, SETTING, storedSchema);

/** Saves the SMTP settings. Pass `password` in plain text; omit it to keep the stored one. */
export async function setMailConfig(
  db: Kysely<CoreDb>,
  secretKey: string,
  input: Partial<MailConfig>,
): Promise<void> {
  const current = await getMailConfig(db);
  const password =
    input.password === undefined
      ? current.password
      : input.password === ""
        ? ""
        : encryptSecret(secretKey, input.password);
  const next = storedSchema.parse({ ...current, ...input, password });
  if (next.enabled && (!next.host || !next.from)) {
    throw new AppError(
      400,
      "validation",
      "Host and sender address are required to enable mail",
    );
  }
  await setSetting(db, SETTING, next);
}

export interface Message {
  to: string;
  subject: string;
  /** Paragraphs of plain text. The HTML part is built from them. */
  body: string[];
  /** A button under the text. */
  action?: { label: string; url: string };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** One layout for every mail: product name, text, optional button. */
export function renderMail(
  message: Message,
  brand: { productName: string; accent: string },
) {
  const text = [
    ...message.body,
    ...(message.action
      ? [`${message.action.label}: ${message.action.url}`]
      : []),
    `— ${brand.productName}`,
  ].join("\n\n");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#fafafa;font-family:system-ui,sans-serif;color:#171717">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #ebebeb;border-radius:12px"><tr><td style="padding:24px">
<p style="margin:0 0 16px;font-size:14px;font-weight:500">${escapeHtml(brand.productName)}</p>
${message.body.map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:22px">${escapeHtml(p)}</p>`).join("\n")}
${message.action ? `<p style="margin:8px 0 0"><a href="${escapeHtml(message.action.url)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:${escapeHtml(brand.accent)};color:#ffffff;font-size:14px;font-weight:500;text-decoration:none">${escapeHtml(message.action.label)}</a></p>` : ""}
</td></tr></table></body></html>`;
  return { text, html };
}

export interface Mailer {
  /** Queues a mail. Pass the transaction of the change that causes it. */
  send(trx: Kysely<CoreDb>, message: Message): Promise<void>;
  /** Sends at once and throws the SMTP error. For the test button. */
  sendNow(message: Message): Promise<void>;
}

const brandSchema = z.object({
  productName: z.string().optional(),
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});

export function createMailer(
  db: Kysely<CoreDb>,
  secretKey: string,
  queue: Queue,
  /** Name and accent in mails while no brand is set. */
  defaults: { productName: string; accent: string } = {
    productName: "Tickvana",
    accent: "#4f6bff",
  },
): Mailer {
  // One connection pool per configuration, rebuilt when the settings change.
  let cached: { key: string; transport: Transporter } | undefined;
  function transportFor(config: MailConfig): Transporter {
    const key = JSON.stringify(config);
    if (cached?.key !== key) {
      cached?.transport.close();
      cached = {
        key,
        transport: createTransport({
          host: config.host,
          port: config.port,
          secure: config.secure,
          auth: config.user
            ? {
                user: config.user,
                pass: config.password
                  ? decryptSecret(secretKey, config.password)
                  : "",
              }
            : undefined,
        }),
      };
    }
    return cached.transport;
  }

  async function deliver(message: Message, config: MailConfig): Promise<void> {
    const stored = await getSetting(db, "branding", brandSchema);
    const brand = {
      productName: stored.productName ?? defaults.productName,
      accent: stored.accent ?? defaults.accent,
    };
    await transportFor(config).sendMail({
      from: config.from,
      to: message.to,
      subject: message.subject,
      ...renderMail(message, brand),
    });
  }

  queue.job(JOB, async (payload) => {
    const config = await getMailConfig(db);
    // Mail switched off: the job ends here instead of retrying for hours.
    if (!config.enabled) return;
    await deliver(payload as Message, config);
  });

  return {
    async send(trx, message) {
      await queue.enqueue(trx, JOB, message);
    },
    async sendNow(message) {
      const config = await getMailConfig(db);
      if (!config.enabled)
        throw new AppError(409, "mail_disabled", "Mail is not enabled");
      await deliver(message, config);
    },
  };
}

/** Admin API under /core/settings/mail. The password is write-only. */
export async function installMailRoutes(
  scope: FastifyInstance,
  db: Kysely<CoreDb>,
  secretKey: string,
  mailer: Mailer,
): Promise<void> {
  const config = { permission: SYSTEM_ADMIN };
  const publicSchema = storedSchema
    .omit({ password: true })
    .extend({ hasPassword: z.boolean() });
  const r = scope.withTypeProvider<ZodTypeProvider>();

  const read = async () => {
    const { password, ...rest } = await getMailConfig(db);
    return { ...rest, hasPassword: password !== "" };
  };

  r.get(
    "/core/settings/mail",
    { config, schema: { response: { 200: publicSchema } } },
    read,
  );

  r.put(
    "/core/settings/mail",
    {
      config,
      schema: {
        body: inputSchema,
        response: { 200: publicSchema },
      },
    },
    async (req) => {
      await setMailConfig(db, secretKey, req.body);
      return read();
    },
  );

  r.post(
    "/core/settings/mail/test",
    {
      config,
      schema: {
        body: z.object({ to: z.email() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      try {
        await mailer.sendNow({
          to: req.body.to,
          subject: "Test",
          body: ["This is a test message. Mail delivery works."],
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        // The admin needs the server's answer to fix the settings.
        throw new AppError(
          502,
          "mail_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      return reply.status(204).send(null);
    },
  );
}
