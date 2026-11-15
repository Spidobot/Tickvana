# Change log

All notable changes, newest first. Versions follow
[Semantic Versioning](docs/releasing.md#versions).

## [Unreleased]

## [0.1.0] – 2026-11-15

The first release, with everything planned for milestones M1 to M4:

### Tickvana

- Projects with issue types, custom fields (text, numbers, dates, choices,
  people, cascading lists, labels …), field layouts and workflows with an
  editor, conditions, validators and post functions.
- Tickets with history, comments, @-mentions, attachments, work logs,
  watchers, votes, links, sub-tasks, epics, components and versions.
- Boards (Kanban and Scrum) with backlog, sprints and reports.
- SQL instead of a query language: saved and shared queries, CSV and JSON
  export, subscriptions, bulk changes, dashboards with a home dashboard.
- Service desk: request types, customer portal with sign-up, organisations,
  queues, SLAs with business calendars, mail channels in and out, canned
  responses, approvals, satisfaction ratings, a knowledge base from Nuvenna.
- Automations, notifications in the app and by mail, webhooks.

### Nuvenna

- Spaces with a page tree, real-time editing of every page together,
  versions with comparison, comments on the page and on text, labels,
  watching, favourites, likes, blog posts, templates.
- Search, export as Markdown, HTML and a ZIP per space, Markdown import,
  print styles for PDF, public links with expiry, space administration and
  page restrictions.
- Ticket blocks and query blocks, both shown with the reader's rights;
  back-references between pages and tickets.

### Both

- PostgreSQL or MariaDB; Docker images behind Caddy on one origin.
- Sign-in with password or OpenID Connect (tested with Microsoft Entra ID),
  groups from the identity provider, API tokens.
- Branding (name, logo, colours), German and English.
- A shared command palette that finds tickets and pages; an app switcher.
