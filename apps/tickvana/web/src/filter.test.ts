import { expect, it } from "vitest";
import { emptyFilter, fromSql, toSql, type Filter } from "./filter.js";

const BASE =
  "select issue_key, summary, status, assignee, priority from issues";

it("writes SQL from conditions", () => {
  expect(toSql(emptyFilter)).toBe(BASE);
  const filter: Filter = {
    conditions: [
      { column: "status_category", op: "<>", value: "done" },
      { column: "cf_kosten", op: ">", value: "100" },
      { column: "summary", op: "like", value: "%Drucker%" },
      { column: "assignee", op: "is null", value: "ignored" },
    ],
    orderBy: "created_at",
    descending: true,
  };
  expect(toSql(filter)).toBe(
    `${BASE} where status_category <> 'done' and cf_kosten > 100 and summary like '%Drucker%' and assignee is null order by created_at desc`,
  );
});

it("keeps values as data, whatever they contain", () => {
  const sql = toSql({
    conditions: [{ column: "summary", op: "=", value: "x' or '1'='1" }],
    orderBy: "",
    descending: false,
  });
  expect(sql).toBe(`${BASE} where summary = 'x'' or ''1''=''1'`);
  expect(fromSql(sql)!.conditions[0]!.value).toBe("x' or '1'='1");
});

it("drops conditions that are incomplete or name something odd", () => {
  const sql = toSql({
    conditions: [
      { column: "status", op: "=", value: "" },
      { column: "status; drop table x", op: "=", value: "a" },
      { column: "status", op: "= 1 or 1" as "=", value: "a" },
      { column: "priority", op: "=", value: "High" },
    ],
    orderBy: "created_at; drop",
    descending: false,
  });
  expect(sql).toBe(`${BASE} where priority = 'High'`);
});

it("reads its own SQL back", () => {
  const filters: Filter[] = [
    emptyFilter,
    {
      conditions: [{ column: "status", op: "=", value: "To Do" }],
      orderBy: "",
      descending: false,
    },
    {
      conditions: [
        { column: "summary", op: "like", value: "a and b" },
        { column: "resolution", op: "is not null", value: "" },
      ],
      orderBy: "number",
      descending: false,
    },
    {
      conditions: [{ column: "cf_kosten", op: "<", value: "-12.5" }],
      orderBy: "updated_at",
      descending: true,
    },
  ];
  for (const filter of filters)
    expect(fromSql(toSql(filter)), toSql(filter)).toEqual(filter);
  expect(fromSql("")).toEqual(emptyFilter);
  expect(fromSql(`  ${BASE}   where  status = 'Done' ;`)).toEqual({
    conditions: [{ column: "status", op: "=", value: "Done" }],
    orderBy: "",
    descending: false,
  });
});

it("leaves hand-written SQL to the editor", () => {
  for (const sql of [
    "select status, count(*) from issues group by status",
    "select * from issues",
    `${BASE} where status = 'a' or status = 'b'`,
    `${BASE} where lower(status) = 'done'`,
    `${BASE} i join comments c on c.issue_id = i.id`,
    "select issue_key from comments",
    `${BASE} where status in ('a', 'b')`,
  ]) {
    expect(fromSql(sql), sql).toBeNull();
  }
});
