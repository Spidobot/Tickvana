// Tickets of a project as CSV, and CSV back into tickets. Export writes names
// (user e-mail, option text, priority name), import reads them, so an export
// can be edited in a spreadsheet and imported again. Import first runs as a
// dry run; the real import is a bulk job that creates ticket by ticket
// through the normal service, with the importer's rights.
import { AppError, csvCell, requireUser, type AuthUser } from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { TrackContext } from "../context.js";
import type { Field } from "../fields.js";
import type { IssueService } from "../issues.js";
import { queueBulk } from "./bulk.js";

/** RFC 4180, with "," or ";" (what spreadsheets in Germany write) as separator. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const sep =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0)
      ? ";"
      : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) rows.push([...row, cell]);
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

/** Names and ids of everything a cell can refer to, loaded once per import or export. */
async function loadNames(ctx: TrackContext, projectId: string) {
  const { db } = ctx;
  const pairs = (rows: { id: string; name: string }[]) => {
    const byName = new Map<string, string>();
    const byId = new Map<string, string>();
    for (const r of rows) {
      byName.set(r.name.toLowerCase(), r.id);
      byId.set(r.id, r.name);
    }
    return { byName, byId };
  };
  // ponytail: whole lookup tables in memory; fine for thousands of rows.
  const users = await db
    .selectFrom("core_user")
    .select(["id", "email", "display_name"])
    .execute();
  const userNames = pairs(users.map((u) => ({ id: u.id, name: u.email })));
  for (const u of users)
    if (!userNames.byName.has(u.display_name.toLowerCase()))
      userNames.byName.set(u.display_name.toLowerCase(), u.id);
  const options = await db
    .selectFrom("track_field_option")
    .selectAll()
    .execute();
  return {
    user: userNames,
    group: pairs(
      await db.selectFrom("core_group").select(["id", "name"]).execute(),
    ),
    priority: pairs(
      await db.selectFrom("track_priority").select(["id", "name"]).execute(),
    ),
    resolution: pairs(
      await db.selectFrom("track_resolution").select(["id", "name"]).execute(),
    ),
    status: pairs(
      await db.selectFrom("track_status").select(["id", "name"]).execute(),
    ),
    issuetype: pairs(
      await db.selectFrom("track_issue_type").select(["id", "name"]).execute(),
    ),
    components: pairs(
      await db
        .selectFrom("track_component")
        .select(["id", "name"])
        .where("project_id", "=", projectId)
        .execute(),
    ),
    versions: pairs(
      await db
        .selectFrom("track_version")
        .select(["id", "name"])
        .where("project_id", "=", projectId)
        .execute(),
    ),
    securitylevel: pairs(
      await db
        .selectFrom("track_security_level")
        .select(["id", "name"])
        .where("project_id", "=", projectId)
        .execute(),
    ),
    issue: pairs(
      await db
        .selectFrom("track_issue")
        .select(["id", "key as name"])
        .execute(),
    ),
    option: (fieldId: string) =>
      pairs(
        options
          .filter((o) => o.field_id === fieldId)
          .map((o) => ({ id: o.id, name: o.value })),
      ),
  };
}
type Names = Awaited<ReturnType<typeof loadNames>>;
type Pairs = ReturnType<Names["option"]>;

const LIST = /\s*,\s*/;
const CASCADE = " > ";

function lookupTable(field: Field, names: Names): Pairs | null {
  switch (field.type) {
    case "user":
    case "multiuser":
      return names.user;
    case "select":
    case "multiselect":
    case "cascade":
      return names.option(field.id);
    case "group":
    case "priority":
    case "resolution":
    case "status":
    case "issuetype":
    case "components":
    case "versions":
    case "securitylevel":
    case "issue":
      return names[field.type];
    default:
      return null;
  }
}

/** A value as the cell text that fromCell reads back. */
function toCell(field: Field, value: unknown, names: Names): string {
  if (value === null || value === undefined) return "";
  const table = lookupTable(field, names);
  const name = (id: unknown) => table?.byId.get(String(id)) ?? String(id);
  if (Array.isArray(value))
    return value.map(name).join(field.type === "cascade" ? CASCADE : ", ");
  if (table) return name(value);
  if (field.type === "richtext") return paragraphsOf(value).join("\n\n");
  return String(value);
}

function paragraphsOf(doc: unknown): string[] {
  const out: string[] = [];
  const walk = (n: { type?: string; text?: string; content?: unknown[] }) => {
    if (n.type === "paragraph" || n.type === "heading") {
      out.push(
        (n.content ?? [])
          .map((c) => (c as { text?: string }).text ?? "")
          .join(""),
      );
    } else (n.content ?? []).forEach((c) => walk(c as typeof n));
  };
  walk(doc as never);
  return out;
}

/** Cell text as the value the issue service expects. Throws a readable message. */
function fromCell(field: Field, text: string, names: Names): unknown {
  const table = lookupTable(field, names);
  const id = (name: string) => {
    const found = table!.byName.get(name.trim().toLowerCase());
    if (!found) throw new Error(`"${name.trim()}" is unknown`);
    return found;
  };
  switch (field.type) {
    case "number":
    case "duration": {
      const n = Number(text.replace(",", "."));
      if (Number.isNaN(n)) throw new Error("must be a number");
      return n;
    }
    case "checkbox":
      return /^(1|x|true|yes|ja|wahr)$/i.test(text.trim());
    case "richtext":
      return {
        type: "doc",
        content: text.split(/\n{2,}/).map((p) => ({
          type: "paragraph",
          content: p ? [{ type: "text", text: p }] : [],
        })),
      };
    case "labels":
      return text.split(/[\s,]+/).filter(Boolean);
    case "cascade":
      return text.split(CASCADE).map(id);
    case "multiselect":
    case "multiuser":
    case "components":
    case "versions":
      return text.split(LIST).filter(Boolean).map(id);
    default:
      return table ? id(text) : text;
  }
}

/** Fields an import may not set: they change through workflow and type operations. */
const NOT_IMPORTED = new Set(["status", "resolution", "type"]);

export async function importExportRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
  issues: IssueService,
): Promise<void> {
  const { db } = ctx;
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const custom = { permission: "custom" as const };
  const fieldsByKey = async () =>
    new Map(
      (
        (await db.selectFrom("track_field").selectAll().execute()) as Field[]
      ).map((f) => [f.key, f]),
    );

  r.get(
    "/projects/:key/export.csv",
    {
      config: custom,
      schema: { params: z.object({ key: z.string().max(10) }) },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const project = await ctx.project(user, req.params.key);
      const names = await loadNames(ctx, project.id);
      const fields = [...(await fieldsByKey()).values()].sort(
        (a, b) =>
          Number(b.is_system) - Number(a.is_system) ||
          a.key.localeCompare(b.key),
      );
      const lines = [
        ["key", ...fields.map((f) => f.key)].map(csvCell).join(","),
      ];
      // ponytail: at most 20 000 tickets per export; larger ones go through a query.
      for (let offset = 0; offset < 20_000; offset += 500) {
        const page = await issues.list(user, project.key, 500, offset);
        for (const issue of page)
          lines.push(
            [
              issue.key,
              ...fields.map((f) => toCell(f, issue.fields[f.key], names)),
            ]
              .map(csvCell)
              .join(","),
          );
        if (page.length < 500) break;
      }
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="${project.key}.csv"`,
        )
        .send(`\uFEFF${lines.join("\r\n")}\r\n`);
    },
  );

  r.post(
    "/projects/:key/import",
    {
      config: custom,
      bodyLimit: 6 * 1024 * 1024,
      schema: {
        params: z.object({ key: z.string().max(10) }),
        body: z.object({
          csv: z.string().max(5 * 1024 * 1024),
          /** CSV column header → field key, or "type". Columns not named are skipped. */
          mapping: z.record(z.string(), z.string()),
          /** Ticket type for rows without a type column. */
          typeId: z.string(),
          dryRun: z.boolean().default(true),
        }),
      },
    },
    async (req, reply) => {
      const user: AuthUser = requireUser(req);
      const project = await ctx.project(user, req.params.key, "issue.create");
      const [header, ...rows] = parseCsv(req.body.csv);
      if (!header) throw new AppError(400, "validation", "The file is empty");
      if (rows.length > 5000)
        throw new AppError(400, "validation", "At most 5000 rows per import");

      const fields = await fieldsByKey();
      const names = await loadNames(ctx, project.id);
      const columns: { index: number; target: Field | "type" }[] = [];
      for (const [column, target] of Object.entries(req.body.mapping)) {
        const index = header.findIndex((h) => h.trim() === column);
        if (index < 0)
          throw new AppError(400, "validation", `No column "${column}"`);
        if (target === "type") columns.push({ index, target });
        else {
          const field = fields.get(target);
          if (!field || NOT_IMPORTED.has(target))
            throw new AppError(
              400,
              "validation",
              `"${target}" cannot be imported`,
            );
          columns.push({ index, target: field });
        }
      }

      const errors: { key: string; message: string }[] = [];
      const items: {
        label: string;
        type: string;
        fields: Record<string, unknown>;
      }[] = [];
      rows.forEach((cells, i) => {
        const label = `Row ${i + 2}`;
        const item = {
          label,
          type: req.body.typeId,
          fields: {} as Record<string, unknown>,
        };
        for (const { index, target } of columns) {
          const text = cells[index] ?? "";
          if (text.trim() === "") continue;
          try {
            if (target === "type") {
              const id = names.issuetype.byName.get(text.trim().toLowerCase());
              if (!id) throw new Error(`"${text.trim()}" is unknown`);
              item.type = id;
            } else item.fields[target.key] = fromCell(target, text, names);
          } catch (e) {
            errors.push({
              key: label,
              message: `${target === "type" ? "type" : target.key}: ${(e as Error).message}`,
            });
          }
        }
        items.push(item);
      });

      if (req.body.dryRun || errors.length)
        return reply.status(req.body.dryRun ? 200 : 400).send({
          rows: items.length,
          errors,
          preview: items.slice(0, 10),
        });
      const op = await queueBulk(
        ctx,
        user,
        { kind: "create", projectKey: project.key },
        items.map((x) => JSON.stringify(x)),
      );
      return reply.status(202).send(op);
    },
  );
}
