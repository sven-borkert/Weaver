# Weaver deployment behind Traefik

This runbook runs Weaver as its own Compose project (`weaver`) on a host with a
Traefik container on the external `ingress` network. Other applications on the
host share only that Traefik container. Weaver has its own database container,
data directories, systemd units and backups.

The examples use `weaver.example.com` for the host, `registry.example.com/weaver` for
the image registry and `gitlab.example.com` with project `group/weaver` for the
GitLab instance that builds the images. Replace them with your own.

| Item                      | Value                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------- |
| URL                       | `https://weaver.example.com/weaver`                                                   |
| MCP endpoint              | `https://weaver.example.com/weaver/api/mcp`                                           |
| Images                    | `registry.example.com/weaver/{tools,web,worker,mcp}:latest`, built by GitLab CI       |
| Compose file              | `/srv/weaver/docker-compose.yml` (installed by `weaver-upgrade`)                      |
| GitLab token              | `/srv/weaver/gitlab-token` (0600): project access token, `read_api` + `read_registry` |
| Runtime configuration     | `/srv/weaver/web.env` (0600), `/srv/weaver/pg_password` (0600)                        |
| Git data / uploads        | `/srv/weaver/data` (owned by the container user, UID/GID 1000)                        |
| PostgreSQL data           | `/srv/weaver/postgres_data`                                                           |
| Backups                   | `/srv/weaver/backups`                                                                 |
| Initial admin credentials | `/srv/weaver/admin-credentials` (0600)                                                |
| Stack unit                | `weaver-docker.service` → `/usr/local/sbin/weaver-compose-up` (pull + up)             |
| Upgrade helper            | `/usr/local/sbin/weaver-upgrade [ref]`                                                |
| Backup units              | `weaver-backup.timer` / `.service` → `/usr/local/sbin/weaver-backup`                  |

## Routing and isolation

[`docker-compose.yml`](../docker-compose.yml) takes its host-specific values
from `web.env` through `--env-file`: `WEAVER_PUBLIC_HOST`, `WEAVER_BASE_PATH`,
`WEAVER_TRAEFIK_NETWORK`, `WEAVER_TLS_CERTRESOLVER` and `WEAVER_DEPLOY_ROOT`.
Every Compose command must pass `--env-file /srv/weaver/web.env`. Without it,
Compose stops with `set WEAVER_PUBLIC_HOST`.

Traefik routes:

- `/weaver` → web (port 3000)
- `/weaver/api/mcp` and `/.well-known/oauth-protected-resource/weaver/api/mcp` → mcp-server (port 3200)
- `/.well-known/oauth-authorization-server/weaver/…` → web, with `/weaver` prefixed

Weaver does not claim `/.well-known/` at the host root. Authentication cookies
use Weaver's own names (`__Secure-weaver.*`) and `Path=/weaver`, so they never
reach or overwrite the other apps' cookies. `AUTH_URL` is the origin only; the
application path comes from `WEAVER_BASE_PATH`. That value is compiled into the
web image, so changing it requires a rebuild.

## Embeddings through OpenRouter

Weaver can run without an embedding model on the host by using OpenRouter for
the knowledge embedding route. Configure it under **Administration › AI**:

1. Create a connection with provider type **OpenRouter** and an OpenRouter API
   key. The endpoint is fixed at `https://openrouter.ai/api/v1`.
2. Import `qwen/qwen3-embedding-4b` and assign it to the knowledge embedding
   route. Its native size is 2,560 dimensions. Any size from 1 to
   4,000 works; saving a new size re-embeds every project and keeps the
   knowledge graph.
3. OpenRouter is a public HTTPS origin, so it needs no
   `WEAVER_OUTBOUND_ALLOWED_ORIGINS` entry. Only private-range origins are listed
   there.

Document chunks, entity text and semantic search queries are sent to OpenRouter
and to the upstream provider it selects. Pin an upstream provider on the model
if the data must stay with one provider.

Weaver sizes each indexing request from the connection's measured speed: one
chunk until it has a measurement, then about half the connection timeout. A
search whose query embedding takes longer than 5 s returns keyword results.

### Verifying indexing through the admin MCP

With an API key that has **System administration**, the MCP endpoint provides
these checks:

- `get_diagnostics_settings` / `set_diagnostics_settings`: info events are only
  stored at level `standard` or `verbose`. The default `errors` keeps warnings
  and errors only.
- `list_llm_routes` and `test_llm_model`: the embedding route is ready, and
  the model returns the configured number of dimensions.
- `get_knowledge_status` and `list_generation_documents`: generation and
  per-document readiness and failures. A document that exceeds the 23-hour
  enrichment deadline fails with "AI enrichment exceeded its time budget" and
  is retried.
- `list_diagnostic_events`:
  - `knowledge.document.embedded` shows each document's request count, largest
    request, characters, duration and the next request's character budget.
  - `knowledge.search.degraded` warnings mark keyword fallbacks, with `reason`,
    `timeoutMs` and `durationMs`.
  - `ai.request` events carry each provider call's duration and failures.
- `list_ai_usage` / `ai_usage_summary`: per-call embedding usage and latency.
- `queue_summary` / `list_queue_jobs`: pending, active and failed
  `document.ai-enrich` jobs.

## Remote instances

Registering a remote: enter its public URL including base path
(`https://host/weaver`); the other admin registers this instance the same
way. Outbound access to the remote's origin is granted by the registry;
`WEAVER_OUTBOUND_ALLOWED_ORIGINS` is not needed for it.

## Prerequisites

The host needs Docker Compose v2, `jq`, and `flock` (util-linux).

Images are pulled from the project's container registry, and the deploy files
are fetched through the GitLab API. Both need, once:

1. Outbound HTTPS from the host to the registry and the GitLab instance.
2. A project access token (Settings › Access tokens) with the `read_api` and
   `read_registry` scopes, role Reporter, stored on the host and used for the
   registry login:

   ```sh
   install -d -m 0750 /srv/weaver
   umask 077
   printf '%s\n' '<token>' > /srv/weaver/gitlab-token
   docker login registry.example.com --username <token name> --password-stdin < /srv/weaver/gitlab-token
   ```

The username is the token's name; Docker keeps the login in
`/root/.docker/config.json`. Verify the login with a pull:

```sh
docker pull registry.example.com/weaver/web:latest
```

A failure here means the login is missing or the registry is unreachable — fix it now.
Later pulls (`weaver-compose-up`, boot) ignore failures and start with
whatever images are already present, so a broken grant or an expired token
otherwise fails silently there.

Project access tokens expire. Rotate `/srv/weaver/gitlab-token` and re-run
`docker login` before the expiry date: an expired token fails `weaver-upgrade`
loudly, but the boot-time pull in `weaver-docker.service` ignores the failure
and starts silently with stale images.

Every push to `main` publishes `:latest`, `:<short sha>` and
`:<package.json version>` for the four application images; a git tag
publishes `:<tag>`. The three build-cache repositories
(`onenote-reader-build`, `worker-build`, `mcp-build`) publish `:latest` only.
The web image is built for `WEAVER_BASE_PATH=/weaver`; another base path needs
the pipeline variable `WEAVER_BASE_PATH` changed and a rebuild.

## First install

As root on the host:

```sh
install -d -m 0700 /srv/weaver/postgres_data /srv/weaver/backups
install -d -m 0750 -o 1000 -g 1000 /srv/weaver/data

umask 077
openssl rand -hex 32 > /srv/weaver/pg_password
curl -fsS --header "PRIVATE-TOKEN: $(cat /srv/weaver/gitlab-token)" \
  'https://gitlab.example.com/api/v4/projects/group%2Fweaver/repository/files/deploy%2Fweb.env.example/raw?ref=main' \
  -o /srv/weaver/web.env
```

Edit `/srv/weaver/web.env`: set your host, registry and GitLab values, put the `pg_password` value into `DATABASE_URL`,
generate `AUTH_SECRET` (`openssl rand -base64 32`), and set
`WEAVER_ENCRYPTION_KEYS` to `1:<openssl rand -base64 32>`. Keep a copy of the
key ring somewhere safe. Stored LLM credentials cannot be decrypted without it.

Fetch the upgrade helper once by hand; from then on it updates itself, the
Compose file, the other scripts and the units:

```sh
curl -fsS --header "PRIVATE-TOKEN: $(cat /srv/weaver/gitlab-token)" \
  'https://gitlab.example.com/api/v4/projects/group%2Fweaver/repository/files/deploy%2Fweaver-upgrade/raw?ref=main' \
  -o /usr/local/sbin/weaver-upgrade
chmod 0755 /usr/local/sbin/weaver-upgrade
weaver-upgrade main
systemctl enable weaver-docker.service
systemctl enable --now weaver-backup.timer
```

`weaver-upgrade` starts (or, on later runs, reloads) `weaver-docker.service`,
which pulls the images and starts the stack; the one-shot `migrations`
service applies the schema first.

Create the first global Admin once `migrations` has completed. Keep the
generated credentials in a root-only file:

```sh
install -m 0600 /dev/null /srv/weaver/admin-credentials
printf 'WEAVER_BOOTSTRAP_ADMIN_EMAIL=admin@weaver.local\nWEAVER_BOOTSTRAP_ADMIN_PASSWORD=%s\n' \
  "$(openssl rand -base64 24)" > /srv/weaver/admin-credentials
set -a; . /srv/weaver/admin-credentials; set +a
docker compose --env-file /srv/weaver/web.env -f /srv/weaver/docker-compose.yml run --rm \
  -e WEAVER_BOOTSTRAP_ADMIN_EMAIL -e WEAVER_BOOTSTRAP_ADMIN_PASSWORD \
  migrations pnpm --filter @weaver/db bootstrap:admin
```

Create other accounts inside the app at **Administration › Users**. Configure
LLM connections and routes at **Administration › AI**. Each private-range
provider origin must also be listed in
`WEAVER_OUTBOUND_ALLOWED_ORIGINS`. Restart the stack after changing that setting.

## Upgrades

```sh
ssh root@weaver.example.com
systemctl start weaver-backup.service
weaver-upgrade main
```

`weaver-upgrade` accepts `main` only. It resolves the full commit first, fetches
all deploy files at that revision, and strictly pulls its short-SHA image set
before installing anything. It writes that image pin to `web.env`, so later boots
stay on the verified release. An unavailable image aborts the upgrade.
The one-shot migrations container runs before the app containers are recreated;
PostgreSQL is kept running, with a 60-second stop grace for deliberate shutdowns.
Success requires the web health endpoint's exact `commitSha` and healthy worker
and MCP containers. Worker health checks probe queue/database readiness.
After a successful upgrade it removes older Weaver image sets from the host and
keeps the new set and the previous one, which is the rollback target. Each set
takes about 7 GB. `docker image prune` alone never frees them, because every set
keeps its short-SHA tag.

The web image includes Chromium for PDF export since 0.1.147 (about 300 MB
larger); nothing to configure.

Upgrading from 0.1.143 or earlier: the first background maintenance pass after
the upgrade rewrites every document file into the header format of 0.1.143
(one `chore: upgrade document headers` commit per project, pushed to a
configured Git remote). Editors open across that pass get a one-time "Document
changed since you loaded it" on their next save. The knowledge index carries
over; nothing is extracted or embedded again.

Backups, deploy-file installation and Compose reloads share the exclusive
`deploy.lock`. A backup cannot overlap a migration or app recreation. Boot retains
the tolerant registry pull and can start already-cached pinned images offline.
Migrations needing fully quiesced traffic still use the procedure in
[`docs/setup.md`](../docs/setup.md#production-docker-compose-parity).
The pre-upgrade `weaver-backup.service` run stops the application services
while it dumps and archives (see [Backups and restore](#backups-and-restore)),
so the outage begins there, not at the reload. Nothing is built on the host;
the pipeline on `main` must have finished before the upgrade.

### Rollback

Pin the previous short-SHA image tag (preferred) or immutable version and reload:

```sh
sed -i '/^WEAVER_IMAGE_TAG=/d' /srv/weaver/web.env
echo 'WEAVER_IMAGE_TAG=<short sha or version>' >> /srv/weaver/web.env
systemctl reload weaver-docker.service
```

The previous release's images are still on the host. Older releases are
pulled from the registry during the reload, so the registry must be reachable.

Remove the line to follow `:latest` again. The `migrations` service runs the
pinned `tools` image, so rolling back across a migration is only safe when
that migration is backward compatible.

## Verification

```sh
C="docker compose --env-file /srv/weaver/web.env -f /srv/weaver/docker-compose.yml"
$C ps -a
$C logs migrations
curl -fsS https://weaver.example.com/weaver/api/health
curl -fsS https://weaver.example.com/.well-known/oauth-protected-resource/weaver/api/mcp
curl -fsS https://weaver.example.com/.well-known/oauth-authorization-server/weaver/api/auth
```

- `/weaver/api/health` must report the version and `commitSha` of the pipeline
  that built the images (the same values appear in the sidebar footer);
  `buildTime` is the pipeline job's start time, so redeploying the same images
  shows the same build time.
- `postgres`, `web`, `agent-worker`, `ingestion-worker` and `mcp-server` are
  healthy, and `migrations` exited 0.
- Signing in sets only `__Secure-weaver.*` cookies with `Path=/weaver`.
- After routing or authentication changes, confirm that other apps on the host
  still answer. Signing into and out of Weaver must not end their sessions.

## Backups and restore

`weaver-backup.timer` runs daily around 02:40. The run is a short planned
outage: it stops `web`, `agent-worker`, `ingestion-worker` and `mcp-server`
(only those that were running; `postgres` stays up), so nothing writes to the
database or the data tree while it writes `weaver-postgres-<UTC>.sql.gz` (plain
`pg_dump`) and `weaver-data-<UTC>.tar.gz` (the Git repositories and retained
uploads, without abandoned upload temporaries). The two files therefore describe
the same state. It restarts the same services with `compose start` (no rebuild,
no migrations) as soon as the archive is written, and also from its exit trap
when any step fails. The outage lasts the service drain (up to 135 s) plus the
dump, check and archive time.

Before archiving, every repository under `data/git` is checked with
`git fsck --connectivity-only`. A repository that fails does not stop the
backup — the database and the healthy repositories are still written — but the
unit fails, names the repository in its log, and keeps the older backups from
being pruned so a good copy of that repository survives. Any nonzero `tar`
status aborts the run and leaves the previous backups in place. The finished
files are checked with `gzip -t` and `tar -tzf`, and backups older than 14 days
are removed only after a clean run has written a new pair. If the services cannot be
restarted the unit fails after publishing the backup; recover with
`systemctl reload weaver-docker.service`. Run
`systemctl start weaver-backup.service` for an immediate backup.

These checks show that the files are readable and the repositories are
connected, not that a restore works. Rehearsing the restore below on a scratch
host is still a manual runbook item.

Restoring replaces all Weaver content. Stop the application containers, then
restore both files from the same run:

```sh
C="docker compose --env-file /srv/weaver/web.env -f /srv/weaver/docker-compose.yml"
$C stop web agent-worker ingestion-worker mcp-server
$C exec -T postgres psql -U weaver -d postgres -c 'DROP DATABASE weaver' -c 'CREATE DATABASE weaver OWNER weaver'
gunzip -c /srv/weaver/backups/weaver-postgres-<UTC>.sql.gz | $C exec -T postgres psql -v ON_ERROR_STOP=1 -U weaver -d weaver
mv /srv/weaver/data /srv/weaver/data.before-restore
tar -C /srv/weaver -xzf /srv/weaver/backups/weaver-data-<UTC>.tar.gz
systemctl reload weaver-docker.service
```
