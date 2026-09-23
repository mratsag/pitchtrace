# n8n installation

PitchTrace pins the official `docker.n8n.io/n8nio/n8n:2.39.10` image. n8n is
optional and lives behind the `n8n` Compose profile so an existing analyzer-only
installation is not changed by a normal `docker compose up`.

## Local setup

1. Copy `.env.example` to `.env`.
2. Replace every `change-me-before-running` value. Generate independent values:

   ```sh
   openssl rand -hex 32  # ANALYZER_API_KEY
   openssl rand -hex 32  # N8N_DB_PASSWORD
   openssl rand -hex 32  # N8N_ENCRYPTION_KEY
   ```

3. Start the profile with the development override:

   ```sh
   docker compose --profile n8n -f docker-compose.yml -f docker-compose.dev.yml up -d --build
   ```

4. Open `http://127.0.0.1:5678` and create the first owner account. Do not expose
   this initial setup screen to an untrusted network.

The development override publishes n8n only on loopback. PostgreSQL and the
analyzer retain their existing local-only bindings. The production definition
does not publish n8n, analyzer, or either database to the host.

## Isolation and secrets

n8n uses a dedicated PostgreSQL 17 container, database user, database, and
volume. This is deliberate: the historical analyzer database owner is the
PostgreSQL bootstrap superuser, so a second database in that same cluster would
not provide honest bidirectional isolation. The separate service also leaves
existing `pitchtrace-postgres-data` volumes and credentials untouched.

Back up both `pitchtrace-n8n-postgres-data` and `pitchtrace-n8n-data`. The latter
contains n8n settings and encrypted credential material. The encryption key is
not stored in Git; losing it can make stored credentials unreadable. Back up the
database, data volume, workflow exports, and encryption key before upgrades.

Telemetry, diagnostics, templates, version notifications, and community package
installation are disabled. No separate task-runner service is deployed; n8n
2.39 may still initialize its built-in JavaScript runtime. Workflow access to
container environment variables is blocked. No Docker socket, analyzer artifact
directory, or broad host filesystem mount is provided.

## Production

Place n8n behind an authenticated HTTPS reverse proxy and keep port 5678 off the
public Internet. Set `N8N_HOST` and `N8N_PROTOCOL=https` to match the external
origin and follow n8n's reverse-proxy documentation. Restrict access to trusted
operators; the provided Form trigger requires a signed-in n8n user with workflow
execute permission.

Use `docker compose --profile n8n pull` only after reading the target release
notes and taking backups. Do not switch the image to `latest`.

## License boundary

This repository does not redistribute or vendor n8n source. It references the
official image; users operate their own instance. PitchTrace workflow JSON is
MIT-licensed with this project. n8n is fair-code software under its own current
Sustainable Use License and related terms. Hosted, SaaS, embedded, or OEM use
must be reviewed against the then-current n8n terms; this is not legal advice.
