# Query tables

Tickvana and Nuvenna have no query language of their own: filters, boards, queues,
dashboards and the query block in pages are SQL `SELECT` statements. They
run against the **virtual tables** below. These are not real tables: for
every query the engine builds them from the database, cut down to what the
person asking may see (projects, security levels, page restrictions). The
same statement gives each reader their own answer.

Rules:

- One statement, `SELECT` only (`WITH`, `UNION`, subqueries and window
  functions are fine).
- Only the tables listed here, unqualified. Functions from an allow-list
  (aggregates, dates, text, maths).
- Parameters are bound, never pasted: `:current_user`, `:now`, `:project`
  and any you define on a saved query.
- Results are capped (200 rows on screen, 10 000 in exports) and a
  statement is stopped after `QUERY_TIMEOUT_MS`.
- Custom fields appear on `issues` as `cf_<key>`. Multi-value fields are a
  comma-separated text there and one row per value in `issue_field_values`.
- Saved queries are bound to the database dialect: SQL that works on
  PostgreSQL may need changes on MariaDB.

Who may write free SQL: with `DB_QUERY_URL` set (a read-only role, the
bundled compose creates it), everyone granted `query.sql`; without it only
system administrators. Everyone may run saved queries shared with them.

## Examples

Open tickets per assignee:

```sql
select assignee, count(*) as open
from issues
where status_category <> 'done'
group by assignee
order by open desc
```

My tickets, newest change first:

```sql
select issue_key, summary, status, updated_at
from issues
where assignee_id = :current_user and status_category <> 'done'
order by updated_at desc
```

Tickets created per week in the last three months:

```sql
select date_trunc('week', created_at) as week, count(*) as created
from issues
where created_at > :now - interval '90 days'
group by week
order by week
```

(`date_trunc` and `interval` are PostgreSQL; on MariaDB use
`date_format(created_at, '%x-%v')` and `date_sub(:now, interval 90 day)`.)

Time logged per person this month:

```sql
select author, sum(seconds) / 3600.0 as hours
from worklogs
where started_at >= date_trunc('month', :now)
group by author
order by hours desc
```

Pages changed this week, by space (in Nuvenna):

```sql
select space_key, count(*) as changed
from pages
where updated_at > :now - interval '7 days'
group by space_key
```

Tickets mentioned on pages (in Nuvenna):

```sql
select to_id as ticket, count(*) as pages
from links
where from_type = 'page' and to_type = 'issue'
group by to_id
order by pages desc
```

The full list of tables and columns follows. It is generated from the
running engines (`node scripts/catalog.ts`); custom fields of your own
installation are not part of it.
