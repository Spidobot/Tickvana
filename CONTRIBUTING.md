# Contributing to Tickvana and Nuvenna

Thank you for helping. This page is the short version of the rules the code
follows; [CONCEPT.md](CONCEPT.md) (German) has the reasons.

## Layout

```text
packages/core     server foundation shared by both apps: database, migrations,
                  auth, permissions, events and jobs, rich text, query engine,
                  mail, webhooks, attachments, dashboards
packages/ui       design tokens, components, editor, app shell, shared pages
apps/tickvana        Tickvana: server/ (Fastify routes, migrations) and web/ (React)
apps/nuvenna        Nuvenna: the same layout
e2e/              Playwright runs across both apps
docker/           image, compose file, Caddy
scripts/          dev start, build helpers, load test, docs generator
```

## Before you open a pull request

```bash
corepack pnpm build
corepack pnpm lint
corepack pnpm test
corepack pnpm e2e        # when you touched a screen or a flow
```

Tests run against real PostgreSQL **and** MariaDB through Testcontainers, so
Docker must be running. On a synced folder (Nextcloud, OneDrive) a test can
fail with `EBUSY`; run it again.

## Rules

- **Database:** Kysely only, no raw SQL, no vendor functions. Differences
  between PostgreSQL and MariaDB live in `packages/core/src/db/dialect.ts`
  and nowhere else. Every schema change is a new migration; existing
  migrations are never edited.
- **Rights:** every route declares its permission (a test fails otherwise),
  checks go through `can()`, lists filter through `visibleProjectIds()` and
  `visibleSpaceIds()`.
- **Downstream work** (notifications, webhooks, automations, SLA clocks,
  links) reacts to `core_event`. A route handler never calls it directly.
- **Input:** a Zod schema at every API boundary. The same schema produces
  the OpenAPI document and the web client (`scripts/gen-api.mjs`).
- **Rich text:** stored as Tiptap JSON, rendered through the fixed schema in
  `packages/core/src/richtext`. User HTML is never stored or sent out. A new
  node goes into that schema, the renderer and the editor; a test keeps
  editor and schema in step.
- **Query engine:** every change comes with a new case in the attack suite
  (`apps/tickvana/server/src/query.test.ts`, and the Nuvenna table tests).
- **Texts:** every visible string through i18next, German and English
  together.
- **Interface:** tokens and components from `packages/ui`; no colours,
  spacing or font sizes written into feature code.
- **Dependencies:** a new package only when the concept names it or doing
  without would mean more than about a hundred lines of our own; say why in
  the commit.
- **Scope:** build what the task asks. What the concept lists as not planned
  is not prepared for.

## Commits

One commit per task, subject starting with the task id from
[TODO.md](TODO.md) (`T-5: …`), body saying what changed and why. Tests
covering rights, concurrency or time come with the change that needs them.

## Licence

By contributing you agree that your work is published under the
[AGPL-3.0-only](LICENSE).
