// Branding (CONCEPT.md §7) and the first-run setup.
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { Attachments } from "../attachments/index.js";
import { createSession, hashPassword, normalizeEmail } from "../auth/store.js";
import { uuidv7 } from "../db/id.js";
import { SYSTEM_ADMIN, type Permissions } from "../permissions/index.js";
import type { CoreDb } from "../schema.js";
import { AppError } from "../server/index.js";
import { getSetting, setSetting } from "../settings.js";

const SETTING = "branding";
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** What each app looks like until an administrator sets a brand of their own. */
export interface BrandDefaults {
  productName: string;
  accent: string;
}

// Stored values. Name and accent stay empty until an administrator sets
// them; then they apply to both apps (the organisation's own brand).
const storedSchema = z.object({
  productName: z.string().trim().min(1).max(60).optional(),
  accent: hex.optional(),
  /** Shown under the sign-in form. */
  loginText: z.string().max(500).default(""),
  footerText: z.string().max(200).default(""),
  /** Appended to branding.css. System admins only. */
  customCss: z.string().max(50_000).default(""),
});
const brandingSchema = storedSchema.extend({
  productName: z.string(),
  accent: hex,
});
export type Branding = z.infer<typeof brandingSchema>;

const stored = (db: Kysely<CoreDb>) => getSetting(db, SETTING, storedSchema);

/** The branding in effect: what the administrator set, else the app's own. */
export async function getBranding(
  db: Kysely<CoreDb>,
  defaults: BrandDefaults,
): Promise<Branding> {
  const s = await stored(db);
  return {
    ...s,
    productName: s.productName ?? defaults.productName,
    accent: s.accent ?? defaults.accent,
  };
}

type Rgb = [number, number, number];
const parse = (color: string): Rgb =>
  [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)) as Rgb;
const format = (rgb: Rgb) =>
  `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
const mix = (a: Rgb, b: Rgb, t: number): Rgb =>
  a.map((c, i) => c + (b[i]! - c) * t) as Rgb;

/** WCAG relative luminance. */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two #rrggbb colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(parse(a)), luminance(parse(b))].sort(
    (x, y) => y - x,
  ) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Moves `color` towards `towards` until it reads on `surface` at 4.5:1. */
function readable(color: string, surface: string, towards: string): string {
  for (let t = 0; t <= 1; t += 0.05) {
    const candidate = format(mix(parse(color), parse(towards), t));
    if (contrast(candidate, surface) >= 4.5) return candidate;
  }
  return towards;
}

/**
 * The colours derived from one accent. Whatever an admin picks, text on the
 * accent and the accent as text keep 4.5:1.
 */
export function accentColors(accent: string) {
  return {
    accent,
    onAccent: contrast(accent, "#ffffff") >= 4.5 ? "#ffffff" : "#171717",
    inkLight: readable(accent, "#ffffff", "#000000"),
    inkDark: readable(accent, "#19191b", "#ffffff"),
  };
}

/** The stylesheet behind /core/branding.css. Overrides the defaults in packages/ui. */
export function brandingCss(branding: Branding): string {
  const c = accentColors(branding.accent);
  const dark = `--brand-accent-ink:${c.inkDark}`;
  return [
    `:root{--brand-accent:${c.accent};--brand-on-accent:${c.onAccent};--brand-accent-ink:${c.inkLight}}`,
    `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${dark}}}`,
    `:root[data-theme="dark"]{${dark}}`,
    branding.customCss,
  ].join("\n");
}

const IMAGE_SLOTS = ["logo-light", "logo-dark", "favicon"] as const;

export interface BrandingRouteOptions {
  db: Kysely<CoreDb>;
  permissions: Permissions;
  attachments: Attachments;
  /** Path of this app's API, e.g. /tickvana/api. */
  apiBase: string;
  /** Name and accent of this app when no brand is set. */
  defaults: BrandDefaults;
  setSessionCookie: (reply: FastifyReply, token: string) => void;
}

/** Registers /core/branding, /core/branding.css and /core/setup. */
export async function installBrandingRoutes(
  scope: FastifyInstance,
  opts: BrandingRouteOptions,
): Promise<void> {
  const { db } = opts;
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const open = { permission: "public" as const };

  // Images are attachments of the owner type "branding": readable by everyone
  // (the login page shows the logo), writable by system admins.
  opts.attachments.registerOwner("branding", {
    canRead: async () => true,
    canWrite: async (user, slot) =>
      (IMAGE_SLOTS as readonly string[]).includes(slot) &&
      opts.permissions.can(user, SYSTEM_ADMIN),
  });

  const publicSchema = brandingSchema.omit({ customCss: true }).extend({
    logoLightUrl: z.string().nullable(),
    logoDarkUrl: z.string().nullable(),
    faviconUrl: z.string().nullable(),
  });

  const read = async () => {
    const { customCss, ...branding } = await getBranding(db, opts.defaults);
    void customCss; // admins read it through /core/branding/custom-css
    const images = await db
      .selectFrom("core_attachment")
      .select(["id", "owner_id"])
      .where("owner_type", "=", "branding")
      .orderBy("id", "desc")
      .execute();
    // The newest upload of a slot wins.
    const url = (slot: string) => {
      const image = images.find((i) => i.owner_id === slot);
      return image ? `${opts.apiBase}/core/attachments/${image.id}` : null;
    };
    return {
      ...branding,
      logoLightUrl: url("logo-light"),
      logoDarkUrl: url("logo-dark"),
      faviconUrl: url("favicon"),
    };
  };

  r.get(
    "/core/branding",
    { config: open, schema: { response: { 200: publicSchema } } },
    read,
  );

  r.get("/core/branding.css", { config: open }, async (_req, reply) =>
    reply
      .header("content-type", "text/css; charset=utf-8")
      .header("cache-control", "no-cache")
      .send(brandingCss(await getBranding(db, opts.defaults))),
  );

  r.get(
    "/core/branding/custom-css",
    {
      config: { permission: SYSTEM_ADMIN },
      schema: { response: { 200: z.object({ customCss: z.string() }) } },
    },
    async () => ({ customCss: (await stored(db)).customCss }),
  );

  // No defaults here: a default would overwrite fields the caller left out.
  const input = z
    .object({
      productName: z.string().trim().min(1).max(60),
      accent: hex,
      loginText: z.string().max(500),
      footerText: z.string().max(200),
      customCss: z.string().max(50_000),
    })
    .partial();

  r.put(
    "/core/branding",
    {
      config: { permission: SYSTEM_ADMIN },
      schema: { body: input, response: { 200: publicSchema } },
    },
    async (req) => {
      await setSetting(
        db,
        SETTING,
        storedSchema.parse({ ...(await stored(db)), ...req.body }),
      );
      return read();
    },
  );

  // --- First run ------------------------------------------------------------

  const hasUsers = async (q: Kysely<CoreDb>) =>
    (await q
      .selectFrom("core_user")
      .select("id")
      .limit(1)
      .executeTakeFirst()) !== undefined;

  r.get(
    "/core/setup",
    {
      config: open,
      schema: { response: { 200: z.object({ needed: z.boolean() }) } },
    },
    async () => ({ needed: !(await hasUsers(db)) }),
  );

  r.post(
    "/core/setup",
    {
      config: { ...open, rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        body: z.object({
          email: z.email().max(320),
          displayName: z.string().trim().min(1).max(200),
          password: z.string().min(10).max(200),
          locale: z.string().min(2).max(10).default("en"),
          timezone: z.string().min(1).max(64).default("UTC"),
          productName: z.string().trim().min(1).max(60).optional(),
          accent: hex.optional(),
        }),
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    async (req, reply) => {
      const now = new Date();
      const id = uuidv7();
      const passwordHash = await hashPassword(req.body.password);
      await db.transaction().execute(async (trx) => {
        // Open only while the installation has no account at all.
        if (await hasUsers(trx))
          throw new AppError(409, "conflict", "Setup is already complete");
        await trx
          .insertInto("core_user")
          .values({
            id,
            email: normalizeEmail(req.body.email),
            display_name: req.body.displayName,
            password_hash: passwordHash,
            kind: "internal",
            active: true,
            locale: req.body.locale,
            timezone: req.body.timezone,
            created_at: now,
            updated_at: now,
          })
          .execute();
        await trx
          .insertInto("core_global_grant")
          .values({
            id: uuidv7(),
            permission: SYSTEM_ADMIN,
            grantee_type: "user",
            grantee_id: id,
            created_at: now,
          })
          .execute();
      });
      const { productName, accent } = req.body;
      if (productName || accent) {
        await setSetting(
          db,
          SETTING,
          storedSchema.parse({
            ...(await stored(db)),
            ...(productName && { productName }),
            ...(accent && { accent }),
          }),
        );
      }
      opts.setSessionCookie(reply, await createSession(db, id));
      return reply.status(201).send({ id });
    },
  );
}
