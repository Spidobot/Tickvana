import { describe, expect, it } from "vitest";
import { QueryError, scanSql, validateQuery } from "./validate.js";

const TABLES = new Set(["issues", "comments", "users", "projects"]);
const dialects = ["postgres", "mysql"] as const;

/** Scans and validates like the engine does. */
const check = (sql: string, dialect: (typeof dialects)[number]) =>
  validateQuery(scanSql(sql, dialect).parseText, dialect, TABLES);

describe.each(dialects)("query validation on %s", (dialect) => {
  const ok = (sql: string) => check(sql, dialect);
  const refused = (sql: string) => {
    try {
      check(sql, dialect);
    } catch (e) {
      if (e instanceof QueryError) return e.message;
      throw e;
    }
    return null;
  };

  it("accepts ordinary reporting queries", () => {
    expect([
      ...ok(
        "select issue_key, summary from issues where status = 'Done' order by created_at desc",
      ).tables,
    ]).toEqual(["issues"]);
    const joined = ok(`
      with recent as (select id, assignee from issues where created_at > :since)
      select u.display_name, count(*) as n, max(lower(i.summary))
      from recent r join issues i on i.id = r.id left join users u on u.id = i.assignee
      where i.project = :project and i.id in (select issue_id from comments)
      group by u.display_name having count(*) > 1
      union all select 'total', count(*), null from issues`);
    expect([...joined.tables].sort()).toEqual(["comments", "issues", "users"]);
    expect(
      ok(
        "select row_number() over (partition by project order by created_at) from issues",
      ).tables.has("issues"),
    ).toBe(true);
    expect(
      ok(
        "select case when priority = 'High' then 1 else 0 end, coalesce(assignee, 'x') from issues;",
      ).star,
    ).toBe(false);
  });

  it("reports star and custom-field columns", () => {
    expect(ok("select * from issues").star).toBe(true);
    expect(ok("select i.* from issues i").star).toBe(true);
    const q = ok(
      "select issue_key, cf_standort, i.CF_Geraet from issues i where cf_kosten > 100 order by cf_standort",
    );
    expect([...q.customColumns].sort()).toEqual([
      "cf_geraet",
      "cf_kosten",
      "cf_standort",
    ]);
    expect(q.star).toBe(false);
  });

  it("refuses anything that is not a single SELECT", () => {
    for (const sql of [
      "delete from issues",
      "update issues set summary = 'x'",
      "insert into issues (id) values ('x')",
      "drop table issues",
      "truncate issues",
      "select 1; delete from issues",
      "select 1; select 2",
      "with d as (delete from issues returning id) select * from d",
    ]) {
      expect(refused(sql), sql).not.toBeNull();
    }
    expect(refused("select * into backup from issues")).toMatch(/INTO|Syntax/);
  });

  it("refuses tables outside the catalog, however they are written", () => {
    for (const sql of [
      "select * from core_user",
      "select * from core_session",
      "select * from public.issues",
      "select * from information_schema.tables",
      "select * from pg_catalog.pg_shadow",
      "select * from mysql.user",
      "select * from issues i join core_api_token t on 1 = 1",
      "select (select token_hash from core_api_token limit 1) from issues",
      "select * from issues where id in (select user_id from core_session)",
      "select * from Issues",
      'select * from "core_user"',
    ]) {
      expect(refused(sql), sql).toMatch(/Unknown table|schema|Syntax/);
    }
  });

  it("refuses to let a WITH query replace a built-in table", () => {
    expect(
      refused("with issues as (select 1 as id) select * from issues"),
    ).toMatch(/cannot be redefined/);
    expect(
      refused("select * from (with users as (select 1) select * from users) x"),
    ).toMatch(/cannot be redefined|Syntax/);
    expect(
      ok("with mine as (select * from issues) select * from mine").tables.has(
        "issues",
      ),
    ).toBe(true);
  });

  it("refuses functions that are not on the list", () => {
    for (const fn of [
      "pg_sleep(10)",
      "sleep(10)",
      "benchmark(1000000, md5('x'))",
      "pg_read_file('/etc/passwd')",
      "load_file('/etc/passwd')",
      "version()",
      "current_setting('x')",
      "set_config('a','b',false)",
      "dblink('x','y')",
      "lo_import('/etc/passwd')",
      "query_to_xml('select 1',true,true,'')",
      "pg_ls_dir('.')",
      "user()",
      "database()",
      "public.lower('x')",
    ]) {
      expect(refused(`select ${fn} from issues`), fn).toMatch(
        /not available|schema|Syntax/,
      );
    }
    expect(
      refused("select * from issues where summary = pg_sleep(1)"),
    ).not.toBeNull();
    expect(refused("select * from issues order by sleep(1)")).not.toBeNull();
  });

  it("refuses constructs where parser and database could disagree", () => {
    expect(refused("select 1 from issues -- drop")).toMatch(/Comments/);
    expect(refused("select 1 /* x */ from issues")).toMatch(/Comments/);
    expect(refused("select 'a\\' or 1=1' from issues")).toMatch(/Backslashes/);
    expect(refused("select 'open from issues")).toMatch(/not closed/);
    expect(refused("select e'x' from issues")).toMatch(/Prefixed/);
    expect(refused("select 1 from issues; ")).toBeNull();
    expect(refused("select 1 from issues;;")).toMatch(/one statement/);
    expect(refused("")).toMatch(/empty/);
    expect(refused(`select '${"x".repeat(20_001)}' from issues`)).toMatch(
      /longer/,
    );
  });

  it("keeps parameters out of strings and quoted names", () => {
    const { parts, parseText } = scanSql(
      "select ':keep', \"a:b\" from issues where p = :project and t > :since",
      dialect,
    );
    expect(parts.filter((p) => typeof p !== "string")).toEqual([
      { param: "project" },
      { param: "since" },
    ]);
    expect(parseText).toBe(
      "select ':keep', \"a:b\" from issues where p = NULL and t > NULL",
    );
    expect(scanSql("select 'it''s :x' from issues", dialect).parts).toEqual([
      "select 'it''s :x' from issues",
    ]);
  });
});

it("handles dialect-specific syntax", () => {
  expect(
    scanSql("select created_at::date from issues", "postgres").parts,
  ).toEqual(["select created_at::date from issues"]);
  expect(() => scanSql("select $1 from issues", "postgres")).toThrow(/Dollar/);
  expect(() => scanSql("select $$x$$ from issues", "postgres")).toThrow(
    /Dollar/,
  );
  expect(() => scanSql("select 1 from issues # x", "mysql")).toThrow(
    /Comments/,
  );
  expect(() => scanSql("select ? from issues", "mysql")).toThrow(/Question/);
  expect(
    scanSql("select `key` from issues where a = :a", "mysql").parts,
  ).toEqual(["select `key` from issues where a = ", { param: "a" }]);
  expect(() => check("select * from issues for update", "mysql")).toThrow(
    /Locking|Syntax/,
  );
  expect(() =>
    check("select * from generate_series(1, 10) g", "postgres"),
  ).toThrow(/not available/);
});
