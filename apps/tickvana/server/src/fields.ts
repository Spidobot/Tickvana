// The field engine: what types of custom fields exist, how their values are
// validated, stored in track_issue_field_value and read back, and how a field
// layout decides which fields a form shows. See CONCEPT.md §4.
import { AppError, renderText, RichTextError, sanitizeDoc } from "@tvn/core";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { LayoutOperation, TrackDb } from "./db/schema.js";

type Db = Kysely<TrackDb>;
export type Field = TrackDb["track_field"];

/** One stored row of a value. Multi-value fields use several, ordered by position. */
export interface ValueRow {
  value_text: string | null;
  value_number: number | null;
  value_date: Date | null;
  value_ref: string | null;
}
const row = (part: Partial<ValueRow>): ValueRow => ({
  value_text: null,
  value_number: null,
  value_date: null,
  value_ref: null,
  ...part,
});

/** Looks things up while validating. All answers come from the database. */
interface Lookup {
  option(
    fieldId: string,
    id: string,
  ): Promise<{ id: string; parent_id: string | null } | undefined>;
  exists(
    table: "core_user" | "core_group" | "track_issue",
    id: string,
  ): Promise<boolean>;
}

class Invalid extends Error {}
const fail = (message: string): never => {
  throw new Invalid(message);
};

const str = (v: unknown, max: number): string =>
  typeof v === "string" && v.length <= max
    ? v
    : fail(`must be text of at most ${max} characters`);
const list = (v: unknown, max: number): unknown[] =>
  Array.isArray(v) && v.length <= max
    ? v
    : fail(`must be a list of at most ${max} entries`);
const ref = async (
  lookup: Lookup,
  table: Parameters<Lookup["exists"]>[0],
  v: unknown,
): Promise<ValueRow> => {
  const id = str(v, 36);
  if (!(await lookup.exists(table, id)))
    fail("refers to something that does not exist");
  return row({ value_ref: id });
};

interface TypeDef {
  /** Turns an API value into rows. Receives only non-empty input. */
  parse(
    value: unknown,
    field: Field,
    lookup: Lookup,
  ): Promise<ValueRow[]> | ValueRow[];
  /** Turns stored rows (at least one) back into the API value. */
  format(rows: ValueRow[]): unknown;
  /** Value of a field that has no rows. */
  empty: unknown;
}

const single = (pick: (r: ValueRow) => unknown) => (rows: ValueRow[]) =>
  pick(rows[0]!);

/** Every type a custom field can have. The API value of each is documented at its entry. */
export const FIELD_TYPES: Record<string, TypeDef> = {
  /** string */
  text: {
    parse: (v) => [row({ value_text: str(v, 500) })],
    format: single((r) => r.value_text),
    empty: null,
  },
  /** string */
  textarea: {
    parse: (v) => [row({ value_text: str(v, 100_000) })],
    format: single((r) => r.value_text),
    empty: null,
  },
  /** string, http(s) only */
  url: {
    parse: (v) => {
      const url = str(v, 2000);
      return /^https?:\/\/\S+$/i.test(url)
        ? [row({ value_text: url })]
        : fail("must be an http(s) address");
    },
    format: single((r) => r.value_text),
    empty: null,
  },
  /** rich-text document. Row 0 holds its plain text (for search and SQL), row 1 the document. */
  richtext: {
    parse: (v) => {
      try {
        const doc = sanitizeDoc(v);
        return [
          row({ value_text: renderText(doc) }),
          row({ value_text: JSON.stringify(doc) }),
        ];
      } catch (e) {
        return fail(
          e instanceof RichTextError
            ? e.message
            : "must be a rich-text document",
        );
      }
    },
    format: (rows) => JSON.parse(rows[1]?.value_text ?? "null"),
    empty: null,
  },
  /** number, optionally limited by config.min / config.max */
  number: {
    parse: (v, field) => {
      if (typeof v !== "number" || !Number.isFinite(v))
        return fail("must be a number");
      const { min, max } = JSON.parse(field.config_json) as {
        min?: number;
        max?: number;
      };
      if ((min !== undefined && v < min) || (max !== undefined && v > max))
        fail(`must be between ${min ?? "-∞"} and ${max ?? "∞"}`);
      return [row({ value_number: v })];
    },
    format: single((r) => r.value_number),
    empty: null,
  },
  /** boolean */
  checkbox: {
    parse: (v) =>
      typeof v === "boolean"
        ? [row({ value_number: v ? 1 : 0 })]
        : fail("must be true or false"),
    format: single((r) => r.value_number === 1),
    empty: false,
  },
  /** "YYYY-MM-DD" */
  date: {
    parse: (v) => {
      const day = str(v, 10);
      const at = /^\d{4}-\d{2}-\d{2}$/.test(day)
        ? new Date(`${day}T00:00:00Z`)
        : new Date(NaN);
      return Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== day
        ? fail("must be a date like 2026-11-27")
        : [row({ value_date: at })];
    },
    format: single((r) => r.value_date!.toISOString().slice(0, 10)),
    empty: null,
  },
  /** ISO 8601 date-time */
  datetime: {
    parse: (v) => {
      const at = new Date(str(v, 40));
      return Number.isNaN(at.getTime())
        ? fail("must be a date-time like 2026-11-27T14:30:00Z")
        : [row({ value_date: at })];
    },
    format: single((r) => r.value_date!.toISOString()),
    empty: null,
  },
  /** option id */
  select: {
    parse: async (v, field, lookup) => {
      const option = await lookup.option(field.id, str(v, 36));
      return option
        ? [row({ value_ref: option.id })]
        : fail("is not an option of this field");
    },
    format: single((r) => r.value_ref),
    empty: null,
  },
  /** option ids */
  multiselect: {
    parse: async (v, field, lookup) => {
      const ids = [...new Set(list(v, 100).map((id) => str(id, 36)))];
      const options = await Promise.all(
        ids.map((id) => lookup.option(field.id, id)),
      );
      return options.every(Boolean)
        ? ids.map((id) => row({ value_ref: id }))
        : fail("contains something that is not an option of this field");
    },
    format: (rows) => rows.map((r) => r.value_ref),
    empty: [],
  },
  /** [parent option id] or [parent option id, child option id] */
  cascade: {
    parse: async (v, field, lookup) => {
      const [parentId, childId, ...rest] = list(v, 2);
      if (rest.length) fail("takes at most two levels");
      const parent = await lookup.option(field.id, str(parentId, 36));
      if (!parent || parent.parent_id !== null)
        return fail("first entry must be a top-level option");
      if (childId === undefined) return [row({ value_ref: parent.id })];
      const child = await lookup.option(field.id, str(childId, 36));
      return child?.parent_id === parent.id
        ? [row({ value_ref: parent.id }), row({ value_ref: child.id })]
        : fail("second entry must be a child of the first");
    },
    format: (rows) => rows.map((r) => r.value_ref),
    empty: [],
  },
  /** user id */
  user: {
    parse: async (v, _f, lookup) => [await ref(lookup, "core_user", v)],
    format: single((r) => r.value_ref),
    empty: null,
  },
  /** user ids */
  multiuser: {
    parse: (v, _f, lookup) =>
      Promise.all(
        [...new Set(list(v, 100))].map((id) => ref(lookup, "core_user", id)),
      ),
    format: (rows) => rows.map((r) => r.value_ref),
    empty: [],
  },
  /** group id */
  group: {
    parse: async (v, _f, lookup) => [await ref(lookup, "core_group", v)],
    format: single((r) => r.value_ref),
    empty: null,
  },
  /** issue id */
  issue: {
    parse: async (v, _f, lookup) => [await ref(lookup, "track_issue", v)],
    format: single((r) => r.value_ref),
    empty: null,
  },
  /** strings without spaces */
  labels: {
    parse: (v) =>
      [...new Set(list(v, 100).map((label) => str(label, 100).trim()))].map(
        (label) =>
          /^\S+$/.test(label)
            ? row({ value_text: label })
            : fail("labels must not be empty or contain spaces"),
      ),
    format: (rows) => rows.map((r) => r.value_text),
    empty: [],
  },
};

/** True for "no value": null, undefined, empty text, empty list. `false` is a value. */
export const isEmpty = (value: unknown) =>
  value === null ||
  value === undefined ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);

/** Key of a custom field. It becomes the SQL column cf_<key> in the query engine. */
export const fieldKey = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{1,39}$/,
    "lower-case letters, digits and underscores, starting with a letter",
  );

function lookupFor(db: Db): Lookup {
  return {
    option: (fieldId, id) =>
      db
        .selectFrom("track_field_option")
        .select(["id", "parent_id"])
        .where("id", "=", id)
        .where("field_id", "=", fieldId)
        .where("disabled", "=", false)
        .executeTakeFirst(),
    exists: async (table, id) => {
      let query = db.selectFrom(table).select("id").where("id", "=", id);
      // Deactivated people cannot be picked.
      if (table === "core_user")
        query = (query as ReturnType<typeof db.selectFrom<"core_user">>).where(
          "active",
          "=",
          true,
        ) as typeof query;
      return (await query.executeTakeFirst()) !== undefined;
    },
  };
}

/** Validated values, ready to store: field id to rows. An empty list clears the field. */
export type Normalized = Map<string, ValueRow[]>;

/**
 * Validates API values of custom fields. `input` maps field keys to values;
 * keys that are not custom fields are ignored (system fields are the issue
 * service's business). Throws 400 naming every field that is wrong.
 */
export async function normalizeCustomValues(
  db: Db,
  fields: Field[],
  input: Record<string, unknown>,
): Promise<Normalized> {
  const lookup = lookupFor(db);
  const out: Normalized = new Map();
  const problems: { field: string; message: string }[] = [];

  for (const field of fields) {
    if (field.is_system || !Object.hasOwn(input, field.key)) continue;
    const value = input[field.key];
    const type = FIELD_TYPES[field.type];
    if (!type)
      throw new Error(`Field "${field.key}" has unknown type "${field.type}"`);
    if (isEmpty(value)) {
      out.set(field.id, []);
      continue;
    }
    try {
      out.set(field.id, await type.parse(value, field, lookup));
    } catch (e) {
      if (!(e instanceof Invalid)) throw e;
      problems.push({
        field: field.key,
        message: `${field.name} ${e.message}`,
      });
    }
  }
  if (problems.length)
    throw new AppError(
      400,
      "validation",
      problems.map((p) => p.message).join(". "),
      problems,
    );
  return out;
}

/** Replaces the stored values of the given fields on one issue. Call inside the issue's transaction. */
export async function writeCustomValues(
  trx: Db,
  issueId: string,
  values: Normalized,
): Promise<void> {
  if (values.size === 0) return;
  await trx
    .deleteFrom("track_issue_field_value")
    .where("issue_id", "=", issueId)
    .where("field_id", "in", [...values.keys()])
    .execute();
  const rows = [...values].flatMap(([fieldId, fieldRows]) =>
    fieldRows.map((r, position) => ({
      issue_id: issueId,
      field_id: fieldId,
      position,
      ...r,
    })),
  );
  if (rows.length)
    await trx.insertInto("track_issue_field_value").values(rows).execute();
}

/** Custom-field values of issues as API values: issue id to { key: value }. Fields without rows get their empty value. */
export async function readCustomValues(
  db: Db,
  fields: Field[],
  issueIds: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const custom = fields.filter((f) => !f.is_system);
  const byIssue = new Map<string, Map<string, ValueRow[]>>();
  if (issueIds.length && custom.length) {
    const rows = await db
      .selectFrom("track_issue_field_value")
      .selectAll()
      .where("issue_id", "in", issueIds)
      .orderBy("issue_id")
      .orderBy("field_id")
      .orderBy("position")
      .execute();
    for (const r of rows) {
      if (!byIssue.has(r.issue_id)) byIssue.set(r.issue_id, new Map());
      const perField = byIssue.get(r.issue_id)!;
      if (!perField.has(r.field_id)) perField.set(r.field_id, []);
      perField.get(r.field_id)!.push(r);
    }
  }
  return new Map(
    issueIds.map((id) => [
      id,
      Object.fromEntries(
        custom.map((f) => {
          const stored = byIssue.get(id)?.get(f.id);
          return [
            f.key,
            stored?.length
              ? FIELD_TYPES[f.type]!.format(stored)
              : FIELD_TYPES[f.type]!.empty,
          ];
        }),
      ),
    ]),
  );
}

export interface LayoutItem {
  field: Field;
  required: boolean;
  hidden: boolean;
  tab: string;
}

/** The fields a layout shows for an operation, in order. */
export async function resolveLayout(
  db: Db,
  layoutId: string,
  operation: LayoutOperation,
): Promise<LayoutItem[]> {
  const rows = await db
    .selectFrom("track_field_layout_item as item")
    .innerJoin("track_field as f", "f.id", "item.field_id")
    .selectAll("f")
    .select(["item.required", "item.hidden", "item.tab", "item.position"])
    .where("item.layout_id", "=", layoutId)
    .where("item.operation", "=", operation)
    .orderBy("item.position")
    .execute();
  return rows.map(({ required, hidden, tab, position, ...field }) => {
    void position; // only used for ordering
    return { field, required, hidden, tab };
  });
}

/**
 * Checks required fields of a layout against the values an issue would have.
 * `values` maps field keys (system and custom) to API values.
 */
export function assertRequired(
  items: LayoutItem[],
  values: Record<string, unknown>,
): void {
  const missing = items.filter(
    (i) => i.required && !i.hidden && isEmpty(values[i.field.key]),
  );
  if (missing.length) {
    throw new AppError(
      400,
      "validation",
      `Required: ${missing.map((i) => i.field.name).join(", ")}`,
      missing.map((i) => ({
        field: i.field.key,
        message: `${i.field.name} is required`,
      })),
    );
  }
}

/** Default values of custom fields (config.default), for fields the caller did not send. */
export function withDefaults(
  fields: Field[],
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...input };
  for (const f of fields) {
    if (f.is_system || Object.hasOwn(out, f.key)) continue;
    const { default: value } = JSON.parse(f.config_json) as {
      default?: unknown;
    };
    if (value !== undefined) out[f.key] = value;
  }
  return out;
}
