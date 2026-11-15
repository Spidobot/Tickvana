// The query engine against real data: results, row-level security, limits,
// and the attack suite (Q-6). Runs with a real read-only database role.
import { createDb, grantGlobal, type CoreDb } from "@tvn/core";
import { describeEachDb } from "@tvn/core/testing";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TrackDb } from "./db/schema.js";
import { startTestApp, type TestApp } from "./testing.js";

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describeEachDb<TrackDb>("query engine", (t) => {
  let app: TestApp;
  let task: string;
  const key: Record<string, string> = {};
  const option: Record<string, string> = {};
  const everyone = ["root", "mira", "jonas", "gast", "fremd"];

  const run = (as: string | null, query: string, extra: object = {}) =>
    app.call("POST", "/core/query/run", as, { sql: query, ...extra });
  const rows = async (as: string, query: string, extra: object = {}) => {
    const res = await run(as, query, extra);
    expect(res.statusCode, `${query} → ${res.body.slice(0, 300)}`).toBe(200);
    return res.json().rows as Record<string, unknown>[];
  };
  const column = async (as: string, query: string) =>
    (await rows(as, query)).map((r) => Object.values(r)[0]);
  const create = async (
    as: string,
    projectKey: string,
    summary: string,
    fields: object = {},
  ) =>
    (
      await app.call("POST", "/issues", as, {
        projectKey,
        type: task,
        fields: { summary, ...fields },
      })
    ).json();

  beforeAll(async () => {
    app = await startTestApp(t.url, { queryRole: true, queryTimeoutMs: 1500 });
    await app.addUser("root", { admin: true });
    for (const name of everyone.slice(1)) await app.addUser(name);
    await app.addUser("kunde", { kind: "customer" });
    await grantGlobal(
      app.db as unknown as Kysely<CoreDb>,
      "query.sql",
      "logged_in",
    );

    await app.call("POST", "/projects", "root", {
      key: "WIT",
      name: "Werkstatt-IT",
    });
    await app.call("POST", "/projects", "root", { key: "GEH", name: "Geheim" });
    const roles = Object.fromEntries(
      (await app.db.selectFrom("track_project_role").selectAll().execute()).map(
        (r) => [r.name, r.id],
      ),
    );
    const member = (project: string, role: string, user: string) =>
      app.call("PUT", `/projects/${project}/members`, "root", {
        roleId: roles[role],
        principalType: "user",
        principalId: app.ids[user],
      });
    await member("WIT", "Members", "mira");
    await member("WIT", "Members", "jonas");
    await member("WIT", "Viewers", "gast");
    await member("GEH", "Members", "jonas");
    task = (
      await app.db
        .selectFrom("track_issue_type")
        .select("id")
        .where("name", "=", "Task")
        .executeTakeFirstOrThrow()
    ).id;

    // Custom fields of three kinds.
    const field = async (body: object) =>
      (await app.call("POST", "/fields", "root", body)).json();
    const standort = await field({
      key: "standort",
      name: "Standort",
      type: "select",
    });
    const bereich = await field({
      key: "bereich",
      name: "Bereich",
      type: "multiselect",
    });
    await field({ key: "kosten", name: "Kosten", type: "number" });
    for (const [f, values] of [
      [standort, ["Halle 1", "Halle 2"]],
      [bereich, ["Druck", "Netz", "Lager"]],
    ] as const) {
      for (const value of values) {
        const res = (
          await app.call("POST", `/fields/${f.id}/options`, "root", { value })
        ).json();
        option[value] = res.options.find(
          (o: { value: string }) => o.value === value,
        ).id;
      }
    }

    key.a = (
      await create("mira", "WIT", "Drucker druckt versetzt", {
        standort: option["Halle 2"],
        bereich: [option.Netz, option.Druck],
        kosten: 120.5,
        assignee: app.ids.jonas,
        labels: ["hardware"],
      })
    ).key;
    key.b = (
      await create("jonas", "WIT", "Scanner ohne Akku", {
        standort: option["Halle 1"],
        kosten: 40,
      })
    ).key;
    key.c = (
      await create("mira", "WIT", "WLAN im Versand", {
        labels: ["netz", "hardware"],
      })
    ).key;
    key.geheim = (await create("jonas", "GEH", "Abmahnung")).key;

    // One ticket behind a security level that only its reporter passes.
    const witId = (
      await app.db
        .selectFrom("track_project")
        .select("id")
        .where("key", "=", "WIT")
        .executeTakeFirstOrThrow()
    ).id;
    await app.db
      .insertInto("track_security_level")
      .values({ id: "lvl", project_id: witId, name: "Personal" })
      .execute();
    await app.db
      .insertInto("track_security_level_member")
      .values({
        id: "lvlm",
        level_id: "lvl",
        grantee_type: "reporter",
        grantee_id: null,
      })
      .execute();
    key.verdeckt = (
      await create("mira", "WIT", "Vertraulich", { securityLevel: "lvl" })
    ).key;

    await app.call("POST", `/issues/${key.a}/comments`, "mira", {
      body: doc("Rolle gewechselt"),
    });
    await app.call("POST", `/issues/${key.a}/comments`, "jonas", {
      body: doc("Lieferant insolvent"),
      visibility: "internal",
    });
    await app.call("POST", `/issues/${key.a}/worklogs`, "jonas", {
      seconds: 1800,
    });
    const start = (
      await app.call("GET", `/issues/${key.b}/transitions`, "jonas")
    )
      .json()
      .find((x: { name: string }) => x.name === "Done").id;
    await app.call("POST", `/issues/${key.b}/transitions`, "jonas", {
      transitionId: start,
    });
  }, 180_000);
  afterAll(() => app?.close());

  it("lists the catalog with custom fields as columns", async () => {
    const catalog = (
      await app.call("GET", "/core/query/catalog", "mira")
    ).json();
    expect(catalog.mayWrite).toBe(true);
    const names = catalog.tables.map((x: { name: string }) => x.name);
    expect(names).toEqual([
      "comments",
      "components",
      "issue_components",
      "issue_field_values",
      "issue_history",
      "issue_labels",
      "issue_links",
      "issue_versions",
      "issues",
      "projects",
      "sla_cycles",
      "sprints",
      "user_groups",
      "users",
      "versions",
      "worklogs",
    ]);
    const issues = catalog.tables.find(
      (x: { name: string }) => x.name === "issues",
    ).columns;
    expect(issues.map((c: { name: string }) => c.name)).toEqual(
      expect.arrayContaining([
        "issue_key",
        "status",
        "cf_standort",
        "cf_bereich",
        "cf_kosten",
      ]),
    );
    expect(
      issues.find((c: { name: string }) => c.name === "cf_kosten"),
    ).toMatchObject({ type: "number", description: "Kosten" });
    expect(
      (await app.call("GET", "/core/query/catalog", null)).statusCode,
    ).toBe(401);
  });

  it("answers reporting queries over system and custom fields", async () => {
    expect(
      await rows(
        "mira",
        "select issue_key, summary, status, assignee from issues where project_key = 'WIT' order by number",
      ),
    ).toEqual([
      {
        issue_key: key.a,
        summary: "Drucker druckt versetzt",
        status: "To Do",
        assignee: "jonas",
      },
      {
        issue_key: key.b,
        summary: "Scanner ohne Akku",
        status: "Done",
        assignee: null,
      },
      {
        issue_key: key.c,
        summary: "WLAN im Versand",
        status: "To Do",
        assignee: null,
      },
      {
        issue_key: key.verdeckt,
        summary: "Vertraulich",
        status: "To Do",
        assignee: null,
      },
    ]);

    // Custom fields: single select, several values in stored order, number.
    const cf = await rows(
      "mira",
      "select issue_key, cf_standort, cf_bereich, cf_kosten from issues where cf_kosten > 100",
    );
    expect(cf).toHaveLength(1);
    expect(cf[0]).toMatchObject({
      issue_key: key.a,
      cf_standort: "Halle 2",
      cf_bereich: "Netz, Druck",
    });
    expect(Number(cf[0]!.cf_kosten)).toBe(120.5);

    const perPlace = await rows(
      "mira",
      "select cf_standort as ort, count(*) as n, sum(cf_kosten) as kosten from issues where cf_standort is not null group by cf_standort order by cf_standort",
    );
    expect(perPlace.map((r) => [r.ort, Number(r.n), Number(r.kosten)])).toEqual(
      [
        ["Halle 1", 1, 40],
        ["Halle 2", 1, 120.5],
      ],
    );

    // Joins across virtual tables, a CTE, a window function.
    const labels = await rows(
      "mira",
      "select l.label, count(*) as n from issue_labels l join issues i on i.id = l.issue_id group by l.label order by l.label",
    );
    expect(labels.map((r) => [r.label, Number(r.n)])).toEqual([
      ["hardware", 2],
      ["netz", 1],
    ]);
    const ranked = await column(
      "mira",
      "with open_issues as (select issue_key, number from issues where status_category <> 'done') select row_number() over (order by number desc) from open_issues",
    );
    expect(ranked.map(Number)).toEqual([1, 2, 3]);
    const history = await rows(
      "jonas",
      "select h.field, h.from_text, h.to_text, h.actor from issue_history h join issues i on i.id = h.issue_id where i.issue_key = :key and h.field = 'status'",
      { params: { key: key.b } },
    );
    expect(history).toEqual([
      { field: "status", from_text: "To Do", to_text: "Done", actor: "jonas" },
    ]);
    expect(
      (await column("mira", "select sum(seconds) from worklogs")).map(Number),
    ).toEqual([1800]);
    expect(
      await column(
        "mira",
        "select display_name from users where id = :current_user",
      ),
    ).toEqual(["mira"]);
  });

  it("includes every custom field in select *", async () => {
    const [first] = await rows(
      "mira",
      "select * from issues where issue_key = :key",
      { params: { key: key.a } },
    );
    expect(first).toMatchObject({
      issue_key: key.a,
      project_key: "WIT",
      type: "Task",
      priority: "Medium",
      reporter: "mira",
      cf_standort: "Halle 2",
      cf_bereich: "Netz, Druck",
    });
    expect(Object.keys(first!)).toEqual(
      expect.arrayContaining(["cf_kosten", "created_at", "status_category"]),
    );
  });

  it("shows each user exactly the tickets the API shows them", async () => {
    for (const user of everyone) {
      const fromSql = (
        await column(user, "select issue_key from issues")
      ).sort();
      const fromApi: string[] = [];
      for (const project of ["WIT", "GEH"]) {
        const res = await app.call(
          "GET",
          `/projects/${project}/issues?limit=200`,
          user,
        );
        if (res.statusCode === 200)
          fromApi.push(...res.json().map((i: { key: string }) => i.key));
      }
      expect(fromSql, user).toEqual(fromApi.sort());
    }
    expect(
      (await column("mira", "select issue_key from issues")).sort(),
    ).toEqual([key.a, key.b, key.c, key.verdeckt].sort());
    expect(
      (await column("jonas", "select issue_key from issues")).sort(),
    ).toEqual([key.a, key.b, key.c, key.geheim].sort());
    expect(await column("fremd", "select issue_key from issues")).toEqual([]);
    expect(await column("fremd", "select project_key from projects")).toEqual(
      [],
    );
    expect(
      (await column("root", "select count(*) from issues")).map(Number),
    ).toEqual([5]);
  });

  it("filters dependent tables the same way", async () => {
    // Internal comments: members read them, viewers do not.
    expect(
      (
        await column("mira", "select body from comments order by created_at")
      ).sort(),
    ).toEqual(["Lieferant insolvent", "Rolle gewechselt"]);
    expect(await column("gast", "select body from comments")).toEqual([
      "Rolle gewechselt",
    ]);
    expect(await column("fremd", "select body from comments")).toEqual([]);
    // History and field values of the hidden ticket are hidden with it.
    const hidden = (
      await app.db
        .selectFrom("track_issue")
        .select("id")
        .where("key", "=", key.verdeckt!)
        .executeTakeFirstOrThrow()
    ).id;
    for (const table of [
      "issue_history",
      "issue_field_values",
      "issue_labels",
      "worklogs",
    ]) {
      expect(
        await column(
          "jonas",
          `select count(*) from ${table} where issue_id = '${hidden}'`,
        ),
        table,
      ).toEqual(
        [expect.anything()].map(() =>
          expect.toSatisfy((v: unknown) => Number(v) === 0),
        ),
      );
    }
    expect(await column("gast", "select project_key from projects")).toEqual([
      "WIT",
    ]);
    // Portal customers cannot write SQL at all.
    expect(
      (await run("kunde", "select display_name from users")).statusCode,
    ).toBe(403);
  });

  it("shows versions, components, sprints and groups only where allowed (Q-8)", async () => {
    for (const project of ["WIT", "GEH"]) {
      await app.call("POST", `/projects/${project}/components`, "root", {
        name: `Komponente ${project}`,
      });
      await app.call("POST", `/projects/${project}/versions`, "root", {
        name: `Version ${project}`,
      });
    }
    for (const table of ["components", "versions"]) {
      expect(await column("gast", `select name from ${table}`), table).toEqual([
        table === "components" ? "Komponente WIT" : "Version WIT",
      ]);
      expect(await column("fremd", `select name from ${table}`)).toEqual([]);
      expect((await column("jonas", `select name from ${table}`)).length).toBe(
        2,
      );
    }

    const board = (
      await app.call("POST", "/projects/WIT/boards", "root", {
        name: "Sprintboard",
        kind: "scrum",
      })
    ).json();
    await app.call("POST", `/boards/${board.id}/sprints`, "root", {
      name: "Sprint 1",
    });
    const sprints = (who: string) =>
      column(who, "select name from sprints where board = 'Sprintboard'");
    expect(await sprints("mira")).toEqual(["Sprint 1"]);
    // A board whose query is private to its owner hides its sprints too.
    await app.db
      .updateTable("core_saved_query" as never)
      .set({ visibility: "private", owner_id: app.ids.root! } as never)
      .where("id" as never, "=", board.queryId)
      .execute();
    expect(await sprints("mira")).toEqual([]);
    expect(await sprints("root")).toEqual(["Sprint 1"]);

    await app.call("POST", "/core/groups", "root", { name: "Support" });
    expect(await column("gast", "select name from user_groups")).toContain(
      "Support",
    );
  });

  it("pages, limits, binds parameters and stops long queries", async () => {
    const page = (
      await run("mira", "select issue_key from issues order by number", {
        limit: 2,
      })
    ).json();
    expect(page).toMatchObject({ columns: ["issue_key"], truncated: true });
    expect(page.rows.map((r: { issue_key: string }) => r.issue_key)).toEqual([
      key.a,
      key.b,
    ]);
    const rest = (
      await run("mira", "select issue_key from issues order by number", {
        limit: 2,
        offset: 2,
      })
    ).json();
    expect(rest).toMatchObject({ truncated: false });
    expect(rest.rows).toHaveLength(2);

    // The statement's own order holds on every database, also descending.
    const all = await rows(
      "mira",
      "select issue_key from issues order by number",
    );
    expect(
      await rows("mira", "select issue_key from issues order by number desc"),
    ).toEqual([...all].reverse());

    // A parameter value is data, whatever it contains.
    const evil = "x' or '1'='1";
    expect(
      await rows("mira", "select issue_key from issues where summary = :s", {
        params: { s: evil },
      }),
    ).toEqual([]);
    expect(
      await rows("mira", "select issue_key from issues where summary = :s", {
        params: { s: "WLAN im Versand" },
      }),
    ).toEqual([{ issue_key: key.c }]);
    expect(
      (
        await run(
          "mira",
          "select issue_key from issues where summary = :missing",
        )
      ).statusCode,
    ).toBe(400);
    // Built-ins cannot be overridden: :current_user stays the caller.
    expect(
      await column(
        "mira",
        "select display_name from users where id = :current_user",
      ),
    ).toEqual(["mira"]);
    expect(
      await rows(
        "mira",
        "select display_name from users where id = :current_user",
        { params: { current_user: app.ids.root } },
      ),
    ).toEqual([{ display_name: "mira" }]);

    const started = Date.now();
    const slow = await run(
      "mira",
      "with recursive n(i) as (select 1 union all select i + 1 from n where i < 1000) select count(*) from n a, n b, n c",
    );
    expect(slow.statusCode).toBe(400);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(slow.json().error.message).toMatch(
      /stopped|recurs|timeout|interrupted/i,
    );
    // The connection is fine afterwards.
    expect(
      (await column("mira", "select count(*) from issues")).map(Number),
    ).toEqual([4]);
  });

  it("refuses the attack suite", async () => {
    const attacks = [
      // more than one statement, writes
      "select 1; delete from issues",
      "delete from issues",
      "update issues set summary = 'x'",
      "insert into issues (id) values ('x')",
      "drop table track_issue",
      "with d as (delete from track_issue returning id) select * from d",
      "select * into dump from issues",
      // physical and system tables, qualified names
      "select * from track_issue",
      "select * from core_user",
      "select password_hash from core_user",
      "select * from core_session",
      "select * from core_api_token",
      "select * from core_setting",
      "select * from public.issues",
      "select * from information_schema.tables",
      "select * from pg_catalog.pg_user",
      "select * from mysql.user",
      "select * from issues i, core_session s",
      "select (select id_hash from core_session limit 1) from issues",
      "select * from issues where id in (select user_id from core_api_token)",
      // shadowing a filtered table
      "with issues as (select * from track_issue) select * from issues",
      "with users as (select * from core_user) select * from users",
      // functions
      "select pg_sleep(30)",
      "select sleep(30)",
      "select pg_read_file('/etc/passwd')",
      "select load_file('/etc/passwd')",
      "select current_setting('data_directory')",
      "select version()",
      "select * from issues where summary = cast(pg_sleep(30) as text)",
      "select benchmark(100000000, md5('x'))",
      // lexer tricks
      "select 1 -- \n; delete from issues",
      "select 1 /* */ from issues",
      "select 'a\\' ; delete from issues; --' from issues",
      "select $$x$$",
      "select e'\\x41' from issues",
      "select * from issues for update",
    ];
    for (const attack of attacks) {
      const res = await run("mira", attack);
      expect(res.statusCode, attack).toBe(400);
      expect(res.json().error.code, attack).toBe("query_invalid");
    }
    // Nothing was changed or lost.
    expect(
      (await column("root", "select count(*) from issues")).map(Number),
    ).toEqual([5]);
    expect(
      (await app.db.selectFrom("track_issue").select("id").execute()).length,
    ).toBe(5);
  });

  it("runs under a role that can read only what the tables need", async () => {
    // What would happen if a statement got past the validator: connect as the role and try.
    const role = createDb<unknown>(app.queryUrl!);
    const attempt = (statement: string) =>
      sql
        .raw(statement)
        .execute(role.db)
        .then(
          () => "allowed",
          () => "denied",
        );
    try {
      expect(await attempt("select id, display_name from core_user")).toBe(
        "allowed",
      );
      expect(await attempt("select id from track_issue")).toBe("allowed");
      for (const statement of [
        "select password_hash from core_user",
        "select * from core_user",
        "select * from core_session",
        "select * from core_api_token",
        "select * from core_setting",
        "select * from core_identity",
        "select * from core_job",
        "select * from track_permission_grant",
        "update track_issue set summary = 'x'",
        "delete from track_issue",
        "insert into core_group (id, name, created_at) values ('x', 'x', now())",
        "create table tw_evil (id int)",
        "drop table track_issue",
      ]) {
        expect(await attempt(statement), statement).toBe("denied");
      }
    } finally {
      await role.db.destroy();
    }
  });

  it("needs the permission to write SQL", async () => {
    expect((await run(null, "select 1 from issues")).statusCode).toBe(401);
    expect((await run("kunde", "select 1 from issues")).statusCode).toBe(403);
    expect(
      (await app.call("GET", "/core/query/catalog", "kunde")).json().mayWrite,
    ).toBe(false);
  });
});

describeEachDb<TrackDb>("query engine without a read-only role", (t) => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startTestApp(t.url);
    await app.addUser("root", { admin: true });
    await app.addUser("mira");
    await grantGlobal(
      app.db as unknown as Kysely<CoreDb>,
      "query.sql",
      "logged_in",
    );
  }, 180_000);
  afterAll(() => app?.close());

  it("lets only system administrators write SQL", async () => {
    const run = (as: string, query: string) =>
      app.call("POST", "/core/query/run", as, { sql: query });
    expect((await run("mira", "select count(*) from issues")).statusCode).toBe(
      403,
    );
    expect(
      (await app.call("GET", "/core/query/catalog", "mira")).json().mayWrite,
    ).toBe(false);
    const ok = await run("root", "select count(*) as n from issues");
    expect(ok.statusCode).toBe(200);
    expect(Number(ok.json().rows[0].n)).toBe(0);
    // Still read-only and still validated.
    expect((await run("root", "delete from issues")).statusCode).toBe(400);
    expect((await run("root", "select * from core_session")).statusCode).toBe(
      400,
    );
  });
});
