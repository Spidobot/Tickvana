# Tickvana

**Plan. Track. Get it done.**

Self-hosted issue tracking and service desk: projects, tickets with your own fields and workflows, boards and sprints, a customer portal with SLAs and mail, automations, dashboards — and SQL instead of a query language of its own.

Tickvana works on its own and pairs with **[Nuvenna](https://github.com/spidobot/nuvenna)**
(team wiki with real-time editing): both sit behind one
address, share one sign-in, and show each other's content with the reader's rights.

## Features

- Projects, issue types, custom fields, field layouts, workflows with an editor
- Tickets with history, comments, mentions, attachments, work logs, links, sub-tasks, epics
- Kanban and Scrum boards with backlog, sprints and reports
- SQL on virtual tables that show each reader only what they may see: saved queries, exports, subscriptions, bulk changes, dashboards
- Service desk: request types, customer portal, organisations, queues, SLAs, mail in and out, approvals, satisfaction ratings, a knowledge base from Nuvenna
- Automations, notifications, webhooks, OpenID Connect sign-in, branding, German and English

## Install

Docker, with PostgreSQL or MariaDB:

```bash
cd docker
cp .env.example .env    # set BASE_URL, SECRET_KEY, passwords
docker compose --profile with-db up -d
```

The compose file starts Tickvana, Nuvenna, the database and a Caddy proxy that
puts both apps on one address. Open `BASE_URL`; the first visit creates the
administrator account.

- Image: `ghcr.io/spidobot/tickvana`
- [Installation, settings, upgrades, backups](docs/install.md)
- [Unraid](docs/unraid.md) — templates in [`unraid/`](unraid)
- [Single sign-on with Microsoft Entra ID](docs/sso-entra.md)
- [SQL query tables](docs/query-tables.md)

## Develop

Node 22+, pnpm through `corepack`, Docker for the test databases.

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm lint
corepack pnpm test   # against real PostgreSQL and MariaDB (Testcontainers)
```

See [CONTRIBUTING.md](CONTRIBUTING.md). `packages/core` and `packages/ui` are shared
with Nuvenna and kept in step between both repositories.

## Licence

Copyright © 2026 the Tickvana contributors.
[GNU Affero General Public License v3.0 only](LICENSE): if you run a changed version
for others over a network, offer them its source.
