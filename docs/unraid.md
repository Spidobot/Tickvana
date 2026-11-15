# Tickvana and Nuvenna on Unraid

Four containers on one Docker network: the database, Tickvana, Nuvenna, and a
small Caddy proxy that puts Tickvana and Nuvenna on **one** address (they need
that for the shared sign-in and for showing each other's content). The
templates are in [`unraid/`](../unraid).

## 1. Prepare (once, in the Unraid terminal)

```bash
docker network create tvn
mkdir -p /mnt/user/appdata/tvn/initdb
```

Copy these files from the repository to the server:

| From the repository | To |
| --- | --- |
| `unraid/*.xml` | `/boot/config/plugins/dockerMan/templates-user/` |
| `unraid/Caddyfile` | `/mnt/user/appdata/tvn/Caddyfile` |
| `docker/initdb/10-query-role.sh` | `/mnt/user/appdata/tvn/initdb/` |

Make up three values and keep them somewhere safe:

- a database password,
- a query role password,
- a secret key: `openssl rand -base64 48` (never change it later).

## 2. Add the containers

*Docker → Add Container*, pick the template under *Template*, fill in,
*Apply*. In this order:

1. **tvn-db** — database password and query role password.
   Skip it if you already run PostgreSQL or MariaDB; then create a database
   and the read-only role as in [install.md](install.md#your-own-database).
2. **tickvana** — *Public address* is how you will open the apps,
   e.g. `http://192.168.1.10:8080` (server IP and the proxy port). Secret
   key. In both database addresses replace `PASSWORD` with the matching
   password.
3. **nuvenna** — exactly the same values as Tickvana.
4. **tvn-proxy** — the HTTP port (default 8080) must match the port in
   the public address.

Open the public address. The first visit asks for the administrator
account.

## Behind Nginx Proxy Manager or SWAG

Leave *Site address* at `:80` and point a proxy host at
`http://<unraid-ip>:8080`, with WebSockets enabled (Nuvenna edits in real
time over a WebSocket). Set *Public address* in Tickvana and Nuvenna to the
outside address, e.g. `https://work.example.org`.

## Updating and backing up

- Update: *Check for updates* in the Docker tab updates Tickvana and Nuvenna;
  migrations run when they start. Back up first.
- Back up `/mnt/user/appdata/tvn` (the appdata backup plugin does it)
  while **tvn-db** is stopped, or take a dump:
  `docker exec tvn-db pg_dump -U tvn -Fc tvn > /mnt/user/backup/tvn.dump`.
  Keep the secret key with the backup.

## Before the first release

The templates use the images `ghcr.io/spidobot/tickvana` and `ghcr.io/spidobot/nuvenna` from
the GitHub Container Registry. Until they are published there, build them on a machine with
the repository and Docker and load them onto the server:

```bash
docker build -f docker/Dockerfile --build-arg APP=track -t ghcr.io/spidobot/tickvana:latest .
docker build -f docker/Dockerfile --build-arg APP=pages -t ghcr.io/spidobot/nuvenna:latest .
docker save ghcr.io/spidobot/tickvana:latest ghcr.io/spidobot/nuvenna:latest | ssh root@tower docker load
```
