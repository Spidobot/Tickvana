# Installing and running Tickvana and Nuvenna

## What runs

`docker/compose.yml` starts four containers:

| Service | Role |
| --- | --- |
| `caddy` | Reverse proxy and TLS. Puts both apps on one origin: `/tickvana` and `/nuvenna`. |
| `tickvana` | Tickvana: API, web app and background jobs. |
| `nuvenna` | Nuvenna: API, web app, real-time editing (WebSocket) and jobs. |
| `db` | PostgreSQL 16, only with `--profile with-db`. |

Attachments live in the `data` volume, everything else in the database.

## First start

```bash
cd docker
cp .env.example .env
```

Fill in `.env`:

- `BASE_URL` — the address people open, e.g. `https://work.example.org`.
  Requests that change data must come from this origin.
- `SITE_ADDRESS` — the same host name for automatic HTTPS from Let's
  Encrypt, or `:80` when another proxy in front terminates TLS.
- `SECRET_KEY` — at least 32 random characters (`openssl rand -base64 48`).
  It encrypts stored credentials (IMAP, SMTP, OIDC). **Never change it**
  afterwards, or those become unreadable.
- `DB_PASSWORD`, `QUERY_DB_PASSWORD` — for the bundled database. Put the same
  values into `DB_URL` and `DB_QUERY_URL` in place of the placeholders.

```bash
docker compose --profile with-db up -d
```

Open `BASE_URL`. The first visit shows the set-up page: administrator
account, product name and accent colour. Afterwards, under *Administration*:

- **System → Mail**: SMTP server for notifications, invitations, password
  resets and service-desk replies.
- **System → Sign-in**: single sign-on via OpenID Connect
  ([Entra ID guide](sso-entra.md)).
- **Branding**: logo, colours, product name.

## Your own database

Leave out `--profile with-db` and point `DB_URL` at your server. The scheme
picks the dialect:

```text
DB_URL=postgres://tvn:secret@db.internal:5432/tvn
DB_URL=mysql://tvn:secret@db.internal:3306/tvn
```

The user needs to create tables (migrations run on every start). Tested
against PostgreSQL 16 and MariaDB 11.

### The query engine's read-only role

Free SQL (filters, dashboards, query blocks) runs on a second connection,
`DB_QUERY_URL`, as a role that can only log in. On start the apps grant it
`SELECT` on exactly the tables the virtual tables read, never on sessions,
tokens or password hashes. The bundled database creates the role itself.
For your own PostgreSQL:

```sql
CREATE ROLE tvn_query LOGIN PASSWORD '…';
GRANT USAGE ON SCHEMA public TO tvn_query;
```

For MariaDB:

```sql
CREATE USER 'tvn_query'@'%' IDENTIFIED BY '…';
```

The app's own database user must be allowed to grant (`GRANT OPTION`, or be
the owner of the tables). Without `DB_QUERY_URL` only system
administrators may write SQL, and the administration page says so.

## All settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `DB_URL` | — | `postgres://…` or `mysql://…` |
| `DB_QUERY_URL` | — | Read-only role for the query engine |
| `BASE_URL` | — | Public address |
| `SECRET_KEY` | — | ≥ 32 characters, see above |
| `TRUST_PROXY` | `false` | `true` behind a proxy (set in compose) |
| `ROLE` | `all` | `web` (requests only), `worker` (jobs only) or both |
| `STORAGE_PATH` | `/data` | Attachments |
| `MAX_UPLOAD_MB` | `50` | Largest attachment |
| `QUERY_TIMEOUT_MS` | `15000` | A query statement is stopped after this |
| `QUERY_RATE_PER_MINUTE` | `60` | Statements per person and minute |
| `PORT` | `3000` | Port inside the container |

Tickvana can run as several instances behind the proxy with `ROLE=web` plus one
with `ROLE=worker`. Nuvenna runs as one instance: real-time editing keeps each
open page in that process.

## Upgrading

1. Back up (next section).
2. Set `TVN_VERSION` in `.env` to the new release, then
   `docker compose pull && docker compose up -d`.
3. Migrations run when the apps start. Watch `docker compose logs -f track
   pages`; each logs `Server listening` when done.

Migrations only go forward. To go back, restore the backup taken in step 1.
Read the change log of every release you skip.

## Backing up

There are exactly two things to keep:

- **The database.**
  - PostgreSQL: `docker compose exec db pg_dump -U tvn -Fc tvn > tvn.dump`
  - MariaDB: `mysqldump --single-transaction tvn > tvn.sql`
- **The `data` volume** (attachments):
  `docker run --rm -v tvn_data:/data -v "$PWD":/backup alpine tar czf /backup/data.tgz -C /data .`

And `SECRET_KEY` from `.env`: without it a restored database cannot decrypt
the stored mail and sign-in credentials.

Restoring: stop the apps, restore the dump into an empty database and the
archive into the volume, start again.

## Private networks

Webhooks and service-desk mail accounts may not point into private networks
(localhost, 10.0.0.0/8, 192.168.0.0/16 …) so that nobody can probe your
internal systems through the apps. If your mail server is internal, an
administrator can allow it under *System → Webhooks*.
