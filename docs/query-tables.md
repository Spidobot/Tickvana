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

## Tickvana

For the query workbench, saved queries, boards, queues and dashboards in Tickvana, and for query blocks with Tickvana as their source.

### `comments`

Comments on tickets. Internal ones only where you may read them.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | text | Comment id |
| `issue_id` | text | Ticket id |
| `author_id` | text | User id |
| `author` | text | Name of the author |
| `body` | text | Comment as plain text |
| `visibility` | text | public or internal |
| `created_at` | datetime | When it was written |
| `updated_at` | datetime | Last edit |

### `components`

Components of the projects you may browse.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | text | Component id |
| `project_id` | text | Project id |
| `name` | text | Name |
| `lead_id` | text | User id of the lead |

### `issue_components`

Components, one row per ticket and component.

| Column | Type | Meaning |
| --- | --- | --- |
| `issue_id` | text | Ticket id |
| `component_id` | text | Component id |
| `component` | text | Component name |

### `issue_field_values`

Custom field values row by row, for fields with several values.

| Column | Type | Meaning |
| --- | --- | --- |
| `issue_id` | text | Ticket id |
| `field` | text | Field key |
| `position` | number | Order of the value |
| `value_text` | text | Text value |
| `value_number` | number | Number value |
| `value_date` | datetime | Date value |
| `value_ref` | text | Id of the option, user, group or ticket |

### `issue_history`

Every field change of a ticket, one row per changed field.

| Column | Type | Meaning |
| --- | --- | --- |
| `issue_id` | text | Ticket id |
| `actor_id` | text | User id |
| `actor` | text | Who changed it |
| `field` | text | Field key |
| `from_text` | text | Value before |
| `to_text` | text | Value after |
| `changed_at` | datetime | When |

### `issue_labels`

Labels, one row per ticket and label.

| Column | Type | Meaning |
| --- | --- | --- |
| `issue_id` | text | Ticket id |
| `label` | text | Label |

### `issue_links`

Links between tickets. Only links whose both ends you may see.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | text | Link id |
| `link_type` | text | Type name, e.g. Blocks |
| `from_issue_id` | text | Ticket the link starts at |
| `to_issue_id` | text | Ticket the link points to |

### `issue_versions`

Versions, one row per ticket, version and kind.

| Column | Type | Meaning |
| --- | --- | --- |
| `issue_id` | text | Ticket id |
| `version_id` | text | Version id |
| `version` | text | Version name |
| `kind` | text | fix or affects |
| `release_date` | date | Planned or actual release |
| `released` | boolean | True when released |

### `issues`

Tickets you may see. Custom fields are columns named cf_<key>.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | text | Ticket id |
| `issue_key` | text | Key like ABC-12 |
| `project_id` | text | Project id |
| `project_key` | text | Project key |
| `number` | number | Number inside the project |
| `type` | text | Issue type name |
| `status` | text | Status name |
| `status_category` | text | todo, in_progress or done |
| `priority` | text | Priority name |
| `priority_position` | number | Sort position of the priority, 0 is highest |
| `resolution` | text | Resolution name, empty while open |
| `summary` | text | Summary |
| `description` | text | Description as plain text |
| `reporter_id` | text | User id of the reporter |
| `reporter` | text | Name of the reporter |
| `assignee_id` | text | User id of the assignee |
| `assignee` | text | Name of the assignee |
| `parent_id` | text | Id of the parent ticket |
| `rank` | text | Manual order, sort ascending |
| `due_date` | date | Due date |
| `estimate_sec` | number | Original estimate in seconds |
| `remaining_sec` | number | Remaining estimate in seconds |
| `spent_sec` | number | Logged time in seconds |
| `created_at` | datetime | When the ticket was created |
| `updated_at` | datetime | Last change |
| `resolved_at` | datetime | When it reached a done status |
| `cf_satisfaction` | number | Satisfaction |

### `projects`

Projects you may browse.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | text | Project id |
| `project_key` | text | Key |
| `name` | text | Name |
| `kind` | text | software, service or business |
| `lead_id` | text | User id of the lead |
| `archived` | boolean | True when archived |
| `created_at` | datetime | When it was created |

### `sla_cycles`

SLA clocks of tickets.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | text | Clock id |
| `issue_id` | text | Ticket id |
| `policy` | text | SLA policy |
| `started_at` | datetime | When the clock started |
| `due_at` | datetime | When the goal runs out |
| `stopped_at` | datetime | When the clock stopped |
| `paused` | boolean | Paused right now |
| `breached` | boolean | Goal missed |

### `sprints`

Sprints of the boards you may open (whose query is shared with you).

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | text | Sprint id |
| `board_id` | text | Board id |
| `board` | text | Board name |
| `project_id` | text | Project of the board, if any |
| `name` | text | Name |
| `goal` | text | Goal |
| `state` | text | future, active or closed |
| `start_at` | datetime | Start |
| `end_at` | datetime | End |

### `user_groups`

Groups of people, for staff.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | text | Group id |
| `name` | text | Name |

### `users`

People with an account.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | text | User id |
| `display_name` | text | Name |
| `email` | text | E-mail address |
| `kind` | text | internal, customer or service |
| `active` | boolean | False for deactivated accounts |

### `versions`

Versions of the projects you may browse.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | text | Version id |
| `project_id` | text | Project id |
| `name` | text | Name |
| `start_date` | date | Start |
| `release_date` | date | Planned or actual release |
| `released` | boolean | True once released |

### `worklogs`

Logged work.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | text | Work log id |
| `issue_id` | text | Ticket id |
| `author_id` | text | User id |
| `author` | text | Who logged it |
| `started_at` | datetime | When the work started |
| `seconds` | number | Duration in seconds |
| `note` | text | Note |

## Nuvenna

For query blocks in pages with Nuvenna as their source.

### `links`

Links between pages and tickets: from_type/to_type are page or issue, issues by key.

| Column | Type | Meaning |
| --- | --- | --- |
| `from_type` | text | page or issue |
| `from_id` | text | Page id or ticket key |
| `to_type` | text | page or issue |
| `to_id` | text | Page id or ticket key |
| `kind` | text | mentions, … |
| `created_at` | datetime | When the link was made |

### `page_versions`

Saved versions of the pages you may see.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | text | Version id |
| `page_id` | text | Page id |
| `number` | number | Version number |
| `title` | text | Title at that version |
| `author_id` | text | User id |
| `message` | text | Note given when saving |
| `created_at` | datetime | When it was saved |

### `pages`

Pages, blog posts and templates you may see, not in the trash.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | text | Page id |
| `space_id` | text | Space id |
| `space_key` | text | Key of the space |
| `parent_id` | text | Parent page id |
| `title` | text | Title |
| `kind` | text | page, blog or template |
| `text` | text | Content as plain text |
| `version` | number | Current version number |
| `created_by` | text | User id of the author |
| `created_at` | datetime | When it was created |
| `updated_by` | text | User id of the last editor |
| `updated_at` | datetime | Last change |

### `spaces`

Spaces you may see.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | text | Space id |
| `space_key` | text | Key |
| `name` | text | Name |
| `description` | text | Description |
| `home_page_id` | text | Id of the home page |
| `archived` | boolean | True when archived |
| `created_at` | datetime | When it was created |

### `user_groups`

Groups of people, for staff.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | text | Group id |
| `name` | text | Name |

### `users`

People with an account.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | text | User id |
| `display_name` | text | Name |
| `email` | text | E-mail address |
| `kind` | text | internal, customer or service |
| `active` | boolean | False for deactivated accounts |
