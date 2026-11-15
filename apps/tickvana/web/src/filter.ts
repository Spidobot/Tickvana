// The point-and-click filter: conditions on the `issues` table, turned into
// SQL and read back from SQL of the same simple shape. Anything written by
// hand that does not have that shape is left to the SQL editor.

export const OPERATORS = [
  "=",
  "<>",
  ">",
  "<",
  "like",
  "is null",
  "is not null",
] as const;
export type Operator = (typeof OPERATORS)[number];

export interface Condition {
  column: string;
  op: Operator;
  /** Ignored for "is null" and "is not null". */
  value: string;
}

export interface Filter {
  conditions: Condition[];
  /** Column to sort by, or "" for the database's order. */
  orderBy: string;
  descending: boolean;
}

export const SHOWN = ["issue_key", "summary", "status", "assignee", "priority"];
export const emptyFilter: Filter = {
  conditions: [],
  orderBy: "",
  descending: false,
};

const IDENT = /^[a-z][a-z0-9_]*$/;
const NUMBER = /^-?\d+(\.\d+)?$/;
const needsValue = (op: Operator) => op !== "is null" && op !== "is not null";

/** A value as an SQL literal: numbers bare, everything else a quoted string. */
const literal = (value: string) =>
  NUMBER.test(value) ? value : `'${value.replaceAll("'", "''")}'`;

export function toSql(filter: Filter): string {
  const where = filter.conditions
    .filter(
      (c) =>
        IDENT.test(c.column) &&
        OPERATORS.includes(c.op) &&
        (!needsValue(c.op) || c.value !== ""),
    )
    .map((c) =>
      needsValue(c.op)
        ? `${c.column} ${c.op} ${literal(c.value)}`
        : `${c.column} ${c.op}`,
    );
  return [
    `select ${SHOWN.join(", ")} from issues`,
    where.length ? `where ${where.join(" and ")}` : "",
    IDENT.test(filter.orderBy)
      ? `order by ${filter.orderBy}${filter.descending ? " desc" : ""}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Splits on " and " that is not inside a quoted string. */
function splitConditions(where: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < where.length; i++) {
    const c = where[i]!;
    if (c === "'") quoted = !quoted;
    if (!quoted && where.slice(i, i + 5).toLowerCase() === " and ") {
      parts.push(current);
      current = "";
      i += 4;
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts;
}

/** Reads SQL of the shape `toSql` writes. Returns null for anything else. */
export function fromSql(sql: string): Filter | null {
  const text = sql.trim().replace(/;$/, "").replace(/\s+/g, " ");
  if (text === "") return emptyFilter;
  const head =
    /^select (.+?) from issues( where (.+?))?( order by ([a-z][a-z0-9_]*)( desc| asc)?)?$/i.exec(
      text,
    );
  if (!head) return null;
  // Only the column list the builder itself writes: anything else was edited by hand.
  if (head[1]!.replace(/\s/g, "").toLowerCase() !== SHOWN.join(","))
    return null;

  const conditions: Condition[] = [];
  for (const part of head[3] ? splitConditions(head[3]) : []) {
    const nullCheck = /^([a-z][a-z0-9_]*) (is null|is not null)$/i.exec(
      part.trim(),
    );
    if (nullCheck) {
      conditions.push({
        column: nullCheck[1]!.toLowerCase(),
        op: nullCheck[2]!.toLowerCase() as Operator,
        value: "",
      });
      continue;
    }
    const compare =
      /^([a-z][a-z0-9_]*) (=|<>|>|<|like) ('(?:[^']|'')*'|-?\d+(?:\.\d+)?)$/i.exec(
        part.trim(),
      );
    if (!compare) return null;
    const raw = compare[3]!;
    conditions.push({
      column: compare[1]!.toLowerCase(),
      op: compare[2]!.toLowerCase() as Operator,
      value: raw.startsWith("'") ? raw.slice(1, -1).replaceAll("''", "'") : raw,
    });
  }
  return {
    conditions,
    orderBy: head[5]?.toLowerCase() ?? "",
    descending: head[6]?.trim().toLowerCase() === "desc",
  };
}
