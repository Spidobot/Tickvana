// First line of defence of the query engine (CONCEPT.md §3): decide from the
// text and the syntax tree whether a user's SQL may run at all. The second
// line is the read-only database role the statement runs under.
import nodeSqlParser from "node-sql-parser";
import type { DialectName } from "../db/dialect.js";

export class QueryError extends Error {
  constructor(
    message: string,
    /** Character offset in the SQL text, when known. */
    readonly position?: number,
  ) {
    super(message);
  }
}

export type SqlPart = string | { param: string };

export interface ScannedSql {
  /** The statement cut at its named parameters (`:name`). */
  parts: SqlPart[];
  /** The statement with every parameter replaced by NULL, for the parser. */
  parseText: string;
}

const MAX_LENGTH = 20_000;

/**
 * Reads the statement character by character. It finds the named parameters,
 * and it refuses every construct on which our parser and the database could
 * disagree about where a string or comment ends: comments, backslashes,
 * dollar quoting and prefixed string literals. Without those, what the parser
 * validated is what the database executes.
 */
export function scanSql(input: string, dialect: DialectName): ScannedSql {
  let sql = input.trim();
  if (sql.endsWith(";")) sql = sql.slice(0, -1).trimEnd();
  if (!sql) throw new QueryError("The query is empty");
  if (sql.length > MAX_LENGTH)
    throw new QueryError(`The query is longer than ${MAX_LENGTH} characters`);

  const parts: SqlPart[] = [];
  let text = "";
  let quote: string | null = null;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    const next = sql[i + 1];

    if (c === "\0")
      throw new QueryError("Control characters are not allowed", i);
    if (c === "\\")
      throw new QueryError(
        "Backslashes are not supported. Write '' for a quote inside a string",
        i,
      );

    if (quote) {
      text += c;
      if (c === quote) {
        if (next === quote) {
          text += next;
          i++;
        } else quote = null;
      }
      continue;
    }

    if (c === "'" || c === '"' || (c === "`" && dialect === "mysql")) {
      // E'…', U&'…', N'…', x'…': each has its own escape rules.
      if (c === "'" && /[A-Za-z&]/.test(sql[i - 1] ?? ""))
        throw new QueryError("Prefixed string literals are not supported", i);
      quote = c;
      text += c;
      continue;
    }
    if (c === ";") throw new QueryError("Only one statement is allowed", i);
    if (
      (c === "-" && next === "-") ||
      (c === "/" && next === "*") ||
      (c === "#" && dialect === "mysql")
    ) {
      throw new QueryError("Comments are not supported in queries", i);
    }
    if (c === "$" && dialect === "postgres")
      throw new QueryError(
        "Dollar signs are not supported. Use :name for parameters",
        i,
      );
    if (c === "?" && dialect === "mysql")
      throw new QueryError(
        "Question marks are not supported. Use :name for parameters",
        i,
      );

    if (c === ":") {
      if (next === ":") {
        // PostgreSQL cast (a::text)
        text += "::";
        i++;
        continue;
      }
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1))?.[0];
      if (name) {
        if (text) parts.push(text);
        parts.push({ param: name });
        text = "";
        i += name.length;
        continue;
      }
    }
    text += c;
  }
  if (quote)
    throw new QueryError("A quoted string or identifier is not closed");
  if (text) parts.push(text);

  return {
    parts,
    parseText: parts.map((p) => (typeof p === "string" ? p : "NULL")).join(""),
  };
}

/** Functions a query may call. Everything else is refused, whatever the database offers. */
const FUNCTIONS = new Set(
  [
    // aggregates
    "count sum avg min max string_agg group_concat bool_and bool_or every",
    // text
    "lower upper length char_length character_length substr substring trim ltrim rtrim replace concat concat_ws left right position strpos instr lpad rpad initcap split_part repeat reverse",
    // null handling and comparison
    "coalesce nullif ifnull greatest least",
    // numbers
    "abs round ceil ceiling floor mod power sqrt sign trunc truncate",
    // dates
    "now current_date current_timestamp date_trunc date_part extract age to_char to_date date date_format datediff date_add date_sub timestampdiff year month day hour minute week dayofweek dayofyear quarter last_day make_date unix_timestamp from_unixtime",
    // windows
    "row_number rank dense_rank lag lead first_value last_value nth_value ntile percent_rank cume_dist",
  ]
    .join(" ")
    .split(" "),
);

export interface ValidatedQuery {
  /** Virtual tables the query reads. */
  tables: Set<string>;
  /** Names of referenced columns that start with "cf_", lower-cased. */
  customColumns: Set<string>;
  /** True when the query selects `*` somewhere, so every column must exist. */
  star: boolean;
  /** The outermost statement sorts but has no LIMIT of its own. */
  orderedWithoutLimit: boolean;
}

const parser = new nodeSqlParser.Parser();
const DATABASE: Record<DialectName, string> = {
  postgres: "PostgresQL",
  // The parser's MariaDB grammar rejects a column called status. Its MySQL grammar accepts the same queries.
  mysql: "MySQL",
};

type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const nameOf = (v: unknown): string =>
  typeof v === "string"
    ? v
    : isNode(v)
      ? nameOf(v.value ?? (v.expr as Node | undefined)?.value)
      : "";

/**
 * Parses the statement and checks the tree: one SELECT, only virtual tables or
 * the query's own CTEs, unqualified, and only functions from the list above.
 */
export function validateQuery(
  parseText: string,
  dialect: DialectName,
  virtualTables: ReadonlySet<string>,
): ValidatedQuery {
  let parsed: unknown;
  try {
    parsed = parser.astify(parseText, { database: DATABASE[dialect] });
  } catch (e) {
    const location = (e as { location?: { start?: { offset?: number } } })
      .location?.start?.offset;
    throw new QueryError(
      `Syntax error: ${(e as Error).message.split("\n")[0]!.slice(0, 300)}`,
      location,
    );
  }
  const statements = Array.isArray(parsed) ? parsed : [parsed];
  if (statements.length !== 1)
    throw new QueryError("Only one statement is allowed");
  const ast = statements[0] as Node;
  if (ast.type !== "select")
    throw new QueryError("Only SELECT statements are allowed");

  const result: ValidatedQuery = {
    tables: new Set(),
    customColumns: new Set(),
    star: false,
    orderedWithoutLimit: (() => {
      // A UNION chain carries ORDER BY and LIMIT on its last part.
      let last = ast as {
        orderby?: unknown[] | null;
        limit?: { value?: unknown[] } | null;
        _next?: unknown;
      };
      while (last._next) last = last._next as typeof last;
      return Boolean(last.orderby?.length) && !last.limit?.value?.length;
    })(),
  };
  const cteNames = new Set<string>();

  // Collect CTE names first: a table reference may point at one defined later in the text.
  const collectCtes = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(collectCtes);
    if (!isNode(node)) return;
    if (Array.isArray(node.with)) {
      for (const cte of node.with as Node[]) {
        const name = nameOf(cte.name);
        if (!name) throw new QueryError("A WITH query needs a name");
        // Shadowing would replace a permission-filtered table with the user's own.
        // tw_result is the name the engine gives the statement itself.
        if (name.toLowerCase() === "tw_result")
          throw new QueryError("tw_result is a reserved name");
        if (virtualTables.has(name.toLowerCase()))
          throw new QueryError(
            `"${name}" is a built-in table and cannot be redefined with WITH`,
          );
        cteNames.add(name);
      }
    }
    Object.values(node).forEach(collectCtes);
  };
  collectCtes(ast);

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isNode(node)) return;

    if (node.type === "select" || node.type === undefined) {
      const into = node.into as Node | undefined;
      if (into && (into.position || into.expr))
        throw new QueryError("SELECT … INTO is not allowed");
      if (node.locking_read)
        throw new QueryError(
          "Locking clauses (FOR UPDATE, FOR SHARE) are not allowed",
        );
    }
    if (
      typeof node.type === "string" &&
      node.type !== "select" &&
      [
        "insert",
        "update",
        "delete",
        "replace",
        "create",
        "drop",
        "alter",
        "truncate",
        "call",
        "set",
        "use",
        "show",
        "grant",
        "revoke",
        "lock",
        "unlock",
        "exec",
        "declare",
      ].includes(node.type)
    ) {
      throw new QueryError("Only SELECT statements are allowed");
    }

    // A table reference: an entry of a FROM list.
    if (
      typeof node.table === "string" &&
      "db" in node &&
      node.type !== "column_ref"
    ) {
      if (node.db)
        throw new QueryError(
          `Tables cannot be qualified with a schema: ${String(node.db)}.${node.table}`,
        );
      const name = node.table;
      if (cteNames.has(name)) {
        // the query's own CTE
      } else if (virtualTables.has(name)) {
        result.tables.add(name);
      } else {
        throw new QueryError(
          `Unknown table "${name}". Table names are lower-case, see the catalog for the list`,
        );
      }
    }

    if (node.type === "function") {
      const fn = node.name as Node | undefined;
      if (fn?.schema)
        throw new QueryError("Functions cannot be qualified with a schema");
      const parts = Array.isArray(fn?.name)
        ? (fn.name as unknown[]).map(nameOf)
        : [nameOf(node.name)];
      const name = parts.join(".").toLowerCase();
      if (parts.length !== 1 || !FUNCTIONS.has(name))
        throw new QueryError(`Function "${name}" is not available in queries`);
    }
    if (node.type === "aggr_func" || node.type === "window_func") {
      const name = nameOf(node.name).toLowerCase();
      if (!FUNCTIONS.has(name))
        throw new QueryError(`Function "${name}" is not available in queries`);
    }

    if (node.type === "column_ref") {
      const column = nameOf(node.column);
      if (column === "*") result.star = true;
      else if (column.toLowerCase().startsWith("cf_"))
        result.customColumns.add(column.toLowerCase());
    }
    if (node.type === "star") result.star = true;

    Object.values(node).forEach(walk);
  };
  walk(ast);

  // The parser's own table list must agree with what the walk saw.
  for (const entry of parser.tableList(parseText, {
    database: DATABASE[dialect],
  })) {
    const [kind, db, table] = entry.split("::");
    if (kind !== "select")
      throw new QueryError("Only SELECT statements are allowed");
    if (db && db !== "null")
      throw new QueryError(
        `Tables cannot be qualified with a schema: ${db}.${table}`,
      );
    if (!table || (!virtualTables.has(table) && !cteNames.has(table)))
      throw new QueryError(`Unknown table "${table}"`);
  }
  return result;
}
