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
