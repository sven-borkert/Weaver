# Weaver

Weaver is a self-hosted, multi-project knowledge and documentation platform.
Projects hold rich-text documents, spreadsheet-like tables and uploaded files, all
kept in Git or project storage. A knowledge graph is maintained from that content
automatically, with an AI assistant, scheduled AI tasks and an MCP server on top.

AI is optional: documents, tables and keyword search work without any model configured.

## Quick start

You need Docker with Compose v2 and `openssl`. The first build compiles everything
from source, so expect it to take several minutes or longer.

```sh
git clone https://github.com/sven-borkert/Weaver.git
cd Weaver
./scripts/quickstart-env.sh
docker compose -f docker-compose.quickstart.yml --env-file .env.quickstart up -d --build
```

Open <http://localhost:3000> and sign in with the Admin account from `.env.quickstart`:

```sh
grep BOOTSTRAP_ADMIN .env.quickstart
```

If port 3000 or 3200 is taken, set other ports before generating the file, for
example `WEAVER_WEB_PORT=3100 WEAVER_MCP_PORT=3300 ./scripts/quickstart-env.sh`.

This stack is for trying Weaver on your own machine. It serves plain HTTP and
publishes its ports on `127.0.0.1` only. For a server, follow
[Run in production](#run-in-production).

### Add AI features

Under **Administration › AI**, add a connection to your LLM provider, import its
models and assign them to the routes. Content sent to a route goes to that provider.

Providers on a private network must also be listed in
`WEAVER_OUTBOUND_ALLOWED_ORIGINS` in `.env.quickstart`, and the stack restarted with
the `up -d` command below.

### Manage the stack

Set this once to shorten the commands:

```sh
alias weaver-qs='docker compose -f docker-compose.quickstart.yml --env-file .env.quickstart'
```

| Task                           | Command                                        |
| ------------------------------ | ---------------------------------------------- |
| Show service status            | `weaver-qs ps`                                 |
| Follow logs                    | `weaver-qs logs -f web`                        |
| Stop, keeping data             | `weaver-qs down`                               |
| Upgrade after `git pull`       | `weaver-qs up -d --build`                      |
| Delete all data and start over | `weaver-qs down -v`, then `rm .env.quickstart` |

`down -v` permanently deletes the database and every project repository. Keep
`.env.quickstart` as long as you keep the data: its keys decrypt the stored
credentials and its database password belongs to the existing database.

## What runs

| Service                                             | Purpose                                                         |
| --------------------------------------------------- | --------------------------------------------------------------- |
| `postgres`                                          | PostgreSQL 17 with pgvector                                     |
| `data-permissions`, `migrations`, `bootstrap-admin` | One-shot setup steps; they exit after each start                |
| `web`                                               | Next.js application, on port 3000                               |
| `agent-worker`                                      | Knowledge, assistant, scheduled-task and Git background jobs    |
| `ingestion-worker`                                  | Upload parsing, kept apart so it can't starve assistant runs    |
| `mcp-server`                                        | MCP endpoint for AI clients, at `http://localhost:3200/api/mcp` |

## Run with prebuilt images

GitHub Actions publishes images to GHCR, so you can run Weaver without a checkout or a
build. You need Docker with Compose v2, `curl` and `openssl`. The images are `linux/amd64`
only; on Apple Silicon they run under emulation.

```sh
mkdir weaver && cd weaver
curl -fsSO https://raw.githubusercontent.com/sven-borkert/Weaver/main/deploy/examples/docker-compose.yml

WEB_PORT=3000
MCP_PORT=3200
(umask 077 && openssl rand -hex 32 > pg_password)
(umask 077 && cat > web.env <<ENV
NODE_ENV=production
WEAVER_IMAGE_PREFIX=ghcr.io/sven-borkert/weaver
WEAVER_IMAGE_TAG=latest
WEAVER_BASE_PATH=/weaver
WEAVER_WEB_PORT=$WEB_PORT
WEAVER_MCP_PORT=$MCP_PORT
AUTH_URL=http://localhost:$WEB_PORT
AUTH_SECRET=$(openssl rand -base64 32)
DATABASE_URL=postgresql://weaver:$(cat pg_password)@postgres:5432/weaver?schema=public
WEAVER_ENCRYPTION_KEYS=1:$(openssl rand -base64 32)
WEAVER_DATA_DIR=/data
WEAVER_JOBS_ENABLED=true
WEAVER_MCP_RESOURCE_URL=http://localhost:$MCP_PORT/weaver/api/mcp
WEAVER_OUTBOUND_ALLOWED_ORIGINS=
ENV
)
mkdir data
# On Linux, the containers' user must own the data directory:
[ "$(uname)" != Linux ] || sudo chown 1000:1000 data

docker compose --env-file web.env up -d

ADMIN_PASSWORD="$(openssl rand -hex 16)"
docker compose --env-file web.env run --rm \
  -e WEAVER_BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
  -e WEAVER_BOOTSTRAP_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  migrations pnpm --filter @weaver/db bootstrap:admin
echo "Sign in at http://localhost:$WEB_PORT/weaver as admin@example.com with password $ADMIN_PASSWORD"
```

The `/weaver` path in the address is required, because it's compiled into these images. The
MCP endpoint is at `http://localhost:3200/weaver/api/mcp`.

This setup serves plain HTTP and publishes its ports on all network interfaces, so only use it
on a trusted machine or network. To upgrade, run `docker compose --env-file web.env pull`, then
`docker compose --env-file web.env up -d`. To remove it, run `down -v`, then delete `data` and
`postgres_data`, which deletes all content.

## Build images with GitHub Actions or GitLab CI

[`.github/workflows/build-images.yml`](.github/workflows/build-images.yml) runs the checks and
builds the images on pull requests, `main` and tags. From `main` and tags it pushes
`tools`, `web`, `worker` and `mcp` to `ghcr.io/sven-borkert/weaver/<image>`, tagged the same
way as the GitLab pipeline below. It needs no setup in the repository.

### GitLab CI

[`.gitlab-ci.yml`](.gitlab-ci.yml) runs in a GitLab project, so push or mirror this
repository to one. GitHub doesn't run it. The pipeline:

1. Runs lint, typecheck, formatting and unit tests on every branch, merge request and tag.
2. Builds and smoke-tests the `tools`, `web`, `worker` and `mcp` images.
3. Pushes them to the project's container registry: `latest`, the short SHA and the
   `package.json` version from the default branch, or the tag name from a tag. Other
   branches build without pushing.

It needs the project's container registry enabled and a runner that allows privileged
containers, because the build uses Docker-in-Docker. The pipeline refuses to
overwrite an existing version tag, so bump `version` in `package.json` before each release.

The images are built for the base path `/weaver`, which is compiled into the web image.
To serve Weaver from another path, change `WEAVER_BASE_PATH` in the CI config.

## Run in production

Use images from your registry, not the quick-start build:

- [`deploy/README.md`](deploy/README.md) covers a host behind Traefik with HTTPS, upgrades,
  backups and restore, using [`docker-compose.yml`](docker-compose.yml).
- [`deploy/examples/docker-compose.yml`](deploy/examples/docker-compose.yml) is a single-host
  stack with no reverse proxy; see [Run from registry images](docs/setup.md#run-from-registry-images).

Any address other than loopback needs HTTPS.

## Develop

See [`docs/setup.md`](docs/setup.md) for the local development setup with `pnpm dev`, and
[`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) for the architecture. Changes are listed in
[`docs/CHANGELOG.md`](docs/CHANGELOG.md).
