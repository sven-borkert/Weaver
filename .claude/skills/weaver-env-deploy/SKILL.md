---
name: weaver-env-deploy
description: Use when touching Weaver environment variables, the three local databases, workspace runtime configuration, Docker files, deployment config, the base path, or web/worker health endpoints.
---

# Weaver Environment, Databases & Deployment

For repository mechanics use `weaver-git-store`; for per-user peer OAuth tokens and transfer use `weaver-remote-instances`; for the project-owned machine HTTP API use `weaver-project-api`. Deployment/key-ring configuration remains here.

## Key files

| Path                                                                                                                                | Role                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/config/src/server.ts`                                                                                                     | Shared server parser: database, Better Auth, data root, pool, Git-lock, jobs, and encrypted-credential key ring                                                            |
| `packages/config/src/publicUrls.ts`                                                                                                 | Canonical public MCP resource, OAuth issuer, base-path normalization, and RFC 9728 metadata-path derivation                                                                |
| `packages/config/src/encryptionKeys.ts`                                                                                             | Versioned AES-256-GCM key-ring parser; highest version is active for writes                                                                                                |
| `apps/web/src/env.ts`                                                                                                               | Next.js adapter over the shared schema plus `NEXT_PUBLIC_BASE_PATH`; `SKIP_ENV_VALIDATION` is build-only                                                                   |
| `packages/core/src/knowledge/config.ts`                                                                                             | Knowledge runtime defaults and route-identity fingerprinting; fingerprint excludes credentials/prices/timeouts                                                             |
| `.env` / `.env.test` / `.env.e2e`                                                                                                   | Exact pairs: `weaver`/`./data`, `weaver_test`/`./data-test`, `weaver_e2e`/`./data-e2e`; each has its own `AUTH_SECRET`                                                     |
| `apps/web/next.config.ts`                                                                                                           | Base path, monorepo tracing root, opt-in standalone output, security headers, and build metadata                                                                           |
| `apps/web/src/lib/basePath.ts`                                                                                                      | Browser URL helpers; the Better Auth server basePath stays `/api/auth`, and `authClient` prefixes `NEXT_PUBLIC_BASE_PATH`                                                  |
| `apps/web/src/app/api/health/route.ts`                                                                                              | Public web liveness with version/build metadata                                                                                                                            |
| `apps/web/src/app/.well-known/`                                                                                                     | Root RFC 8414/9728 OAuth discovery routes (`oauth-authorization-server`, `oauth-protected-resource`); served at the origin root, not under the base path                   |
| `packages/db/prisma/bootstrap-admin.ts`                                                                                             | `pnpm db:bootstrap-admin` entry point; reads `WEAVER_BOOTSTRAP_ADMIN_*` and calls `bootstrapAdmin`                                                                         |
| `apps/agent-worker/src/index.ts`, `apps/agent-worker/src/health.ts`, `packages/core/src/runtime/lifecycle.ts`                       | Worker composition (role-gated consumers via `WEAVER_WORKER_ROLES`), signals/shutdown, and dependency-free `/health` server (reports `roles`)                              |
| `packages/config/src/workerRoles.ts`                                                                                                | `WEAVER_WORKER_ROLES` parsing: `knowledge`/`assistant`/`ingestion`/`tasks`/`git`, defaults to all five                                                                     |
| `apps/mcp-server/src/index.ts`                                                                                                      | MCP composition: env, Better Auth verifiers, node listener, shared lifecycle, and `/health`                                                                                |
| `docker/{web,worker,mcp}.Dockerfile`, `.gitlab-ci.yml`, `.github/workflows/build-images.yml`, `deploy/ci/build-images.sh`           | Separate web/tools, worker (also `ingestion-worker`), and MCP images; CI builds them one after another in dind and pushes `latest`/`<sha>`/`<version>` (`main`) or `<tag>` |
| `docker-compose.yml`, `docker-compose.build.yml`, `deploy/examples/docker-compose.yml`                                              | Deployable stack from registry images (`WEAVER_IMAGE_PREFIX`/`WEAVER_IMAGE_TAG`); the overlay adds local builds; the example is a generic single host                      |
| `docker-compose.quickstart.yml`, `scripts/quickstart-env.sh`                                                                        | Local evaluation stack from the README: builds from the checkout with an empty base path, named volumes and loopback-only ports; never a deployment path                   |
| `deploy/README.md`, `deploy/weaver-upgrade`, `deploy/weaver-compose-up`, `deploy/weaver-*.service`/`.timer`, `deploy/weaver-backup` | Live `apps` host runbook (`/weaver`): fetch deploy files by ref, pull + recreate, systemd stack unit, daily pg_dump + Git data backup, restore                             |
| `apps/web/playwright.config.ts`                                                                                                     | Receives `.env.e2e` from the root command, starts web/worker/MCP, and forwards their exact database/data pair                                                              |

## Conventions

- Host Git must be 2.36+ (`git cat-file --batch -z`); `MIN_GIT_VERSION` in
  `packages/git-store/src/gitVersion.ts` is the single source, and the
  workspace shows `GitRuntimeBanner` when `checkGitRuntime()` fails (a passing
  result is cached for the process, a failure for `GIT_FAILURE_CACHE_MS`, 30 s).
  Raise the constant together with `docs/setup.md` when a newer Git feature is used.
- `WEAVER_DATA_DIR` is required with no default. Repositories live at `${WEAVER_DATA_DIR}/git/<projectId>`; keep each database paired with its directory above. A relative value is resolved against the workspace root (located via `pnpm-workspace.yaml`) at parse time, so web, worker, and MCP always share one store regardless of their Turbo working directories.
- `parseServerEnv` and `parseKnowledgeConfig` both treat empty-string values
  as unset and honor `SKIP_ENV_VALIDATION` (also allow-listed in `turbo.json`
  for build/dev), so the build-time escape hatch works through `@weaver/db`,
  the worker, and the knowledge publisher's module-load parse. Under the flag
  `parseKnowledgeConfig` returns jobs-only defaults (`WEAVER_JOBS_ENABLED`
  still honored, AI off) instead of validating.
- `WEAVER_GIT_LOCK_TIMEOUT_MS` and `WEAVER_GIT_LOCK_POOL_MAX` default to
  `10000` and `4` with validated bounds `1..120000` and `1..32`. Lock waits
  block server-side via `lock_timeout` (no poll interval; writers exclusive
  through a per-project in-process turn queue, committed readers shared with
  one waiting pool client per project).
  `WEAVER_WORKER_HEALTH_PORT` is validated `1..65535` (default `3101`);
  `DATABASE_POOL_MAX` is bounded `1..1000` and
  `DATABASE_STATEMENT_TIMEOUT_MS` `0..86400000`.
- The root `db:*`/`test:integration*`/`e2e` scripts run through `scripts/require-env.mjs`, which aborts when the env file is missing, names a different database/data-dir pair than expected, or is overridden by a differing shell `DATABASE_URL`/`WEAVER_DATA_DIR`. Integration/e2e resets recursively delete their Git root as well as truncating their database, so a dev pairing destroys dev state. `dev`, `build`, `start`, and `db:studio` still use plain `dotenv -e .env`.
- Playwright forwards `WEAVER_DATA_DIR` explicitly because Next.js would otherwise read the dev `.env` during build/start. Resolve its repository-relative value from the config file's repository root before forwarding the same absolute path to all three application runtimes; do not depend on their package working directories.
- `pnpm dev` starts `@weaver/web`, `@weaver/agent-worker`, and
  `@weaver/mcp-server`; use `pnpm dev:web`, `pnpm dev:worker`, or
  `pnpm dev:mcp` for one runtime. The local worker health
  endpoint is `127.0.0.1:${WEAVER_WORKER_HEALTH_PORT:-3101}/health`; it returns
  `503 {status:"starting"}` until job workers are registered, then
  `200 {status:"ok"}` (the compose healthcheck checks `r.ok`).
- Build metadata: `APP_BUILD_TIME`/`APP_COMMIT_SHA` are Docker build args (not
  runtime env). `next.config.ts` inlines them plus the root `package.json`
  version as `NEXT_PUBLIC_BUILD_TIME`/`NEXT_PUBLIC_COMMIT_SHA`/
  `NEXT_PUBLIC_APP_VERSION`; `/api/health` and the sidebar footer report them.
  CI stamps both (`$CI_COMMIT_SHA`, `$CI_JOB_STARTED_AT`); the host never
  builds, so `buildTime` names the pipeline run. Browser code reads
  `apps/web/src/lib/buildInfo.ts`; `appVersion.ts` imports `package.json` and
  stays server-side.
- Standalone tracing misses files a package loads by computed path. PDF export
  needs `playwright-core/browsers.json` (`outputFileTracingIncludes` in
  `next.config.ts`); without it the library fails to load and the button stays
  disabled. An include must name the package's real `.pnpm` path
  (`require.resolve`): a glob through `apps/web/node_modules/<package>` copies
  the file beside the symlink, where the server never looks. `next start`, dev
  and e2e use the full `node_modules` and cannot show this, so the CI web smoke
  test launches Chromium inside the built image.
- Bundled server code cannot ask for a package file's path: the bundler compiles
  `createRequire(import.meta.url).resolve("<literal>")` to a numeric module id.
  Read such a file by path from the app directory's `node_modules/…` (the
  working directory in dev, `next start` and standalone, whose `server.js`
  changes into it; the integration suite starts in the repository root, so
  `apps/web` is the second candidate) and copy it there with an include through
  `./node_modules/<package>/…`. The Mermaid bundle and KaTeX stylesheet and fonts for PDF export work this
  way; the web smoke test checks it.
- Compose is split: `docker-compose.yml` is deployable on its own and names
  registry images; `docker-compose.build.yml` is the only file with build
  contexts. `scripts/compose-services.test.mjs` pins both plus the generic
  example; `scripts/ci-build-images.test.mjs` drives the CI build script with a
  stub `docker`; `scripts/deploy-scripts.test.mjs` parses the host scripts.
- Production persists Git content through one compose host bind mount at
  `/data` shared by web, both workers, and MCP. Web and MCP join Traefik; both
  workers stay on the internal network — `agent-worker`'s container healthcheck
  uses port 3101, `ingestion-worker`'s uses 3102 (same worker image, distinct
  `WEAVER_WORKER_ROLES`/`WEAVER_WORKER_HEALTH_PORT`).
- Compose host values come from `--env-file ${WEAVER_DEPLOY_ROOT}/web.env`:
  `WEAVER_PUBLIC_HOST` (required), `WEAVER_BASE_PATH` (`/weaver`, also the web
  build arg), `WEAVER_TRAEFIK_NETWORK` (`ingress`), `WEAVER_TLS_CERTRESOLVER`
  (`letsencrypt`), `WEAVER_DEPLOY_ROOT` (`/srv/weaver`). No service joins
  a network beyond `internal` and Traefik's `ingress`. The host may be shared with
  other apps: never route the bare `/.well-known/` prefix (only
  `/.well-known/oauth-authorization-server<base path>/` and the MCP
  protected-resource path), and keep auth cookies named `weaver.*` with `Path`
  = base path (`cookiePath` in `createWeaverAuth`). Deploy steps live in
  `deploy/README.md`.
- Base path rule: browser-facing links/APIs get `withBasePath()`; the Better Auth server basePath is fixed at `/api/auth` while `authClient` prefixes `NEXT_PUBLIC_BASE_PATH`; redirect() in RSC prepends basePath itself.
- Optional external browser login uses `WEAVER_OIDC_DISCOVERY_URL`,
  `WEAVER_OIDC_CLIENT_ID`, and `WEAVER_OIDC_CLIENT_SECRET` together, plus optional
  `WEAVER_OIDC_DISPLAY_NAME`. `getOidcProvider` validates completeness in both
  shared parsing and the Next runtime adapter. Environment fallback is read at startup;
  recreate web after environment edits. Prefer the encrypted `auth.oidc` settings
  managed under Administration > Settings > OIDC, which activate on the next
  request without a restart and override environment values even when disabled. Read `weaver-oidc` for provider identity, callbacks,
  verified-email policy, and Authentik setup.
- `WEAVER_AUTH_RATE_LIMIT_ENABLED` (`true`/`false`, optional) overrides Better Auth's own default of rate limiting only in production; `apps/web/playwright.config.ts` sets it `false` for the web, worker, and MCP e2e processes since the suite signs in repeatedly from one IP against a production build.
- MCP public URLs follow spec §26.2 items 5–6: `WEAVER_MCP_RESOURCE_URL`
  (optional) is both the audience and endpoint URL and defaults to
  `<AUTH_URL origin><base path>/api/mcp`; `WEAVER_OAUTH_ISSUER` (optional)
  defaults to `<AUTH_URL origin><base path>/api/auth`. Better Auth rejects a
  non-loopback `http://` resource, so production needs `https://`.
- MCP runtime bounds: `WEAVER_MCP_PORT` `1..65535` (3200),
  `WEAVER_MCP_MAX_BODY_BYTES` `1024..16777216` (1048576),
  `WEAVER_MCP_MAX_RESOURCE_CHARS` `1000..2000000` (200000),
  `WEAVER_MCP_TOOL_TIMEOUT_MS` `1000..120000` (30000),
  `WEAVER_MCP_RATE_LIMIT_PER_MINUTE` `1..100000` (600), and
  `WEAVER_MCP_ANON_RATE_LIMIT_PER_MINUTE` `1..100000` (60).
  `WEAVER_MCP_ALLOWED_HOSTS` and `WEAVER_MCP_ALLOWED_ORIGINS` are optional
  comma-separated additions to the derived allowlists.
- `WEAVER_AUTH_TRUST_PROXY` defaults to `false`. The private Compose web listener
  opts in to proxy-written `X-Real-IP` for sign-in rate limiting; forwarded chains
  are not trusted. This is independent of MCP proxy configuration.
- `WEAVER_MCP_TRUST_PROXY` defaults to `false` and is never implied by
  `NODE_ENV`. Enable it only for a private listener behind one controlled
  proxy which appends the direct client as the right-most `X-Forwarded-For`
  hop; the supplied Compose MCP service is that boundary and opts in. Keep it
  false for direct or differently proxied deployments.
- MCP shutdown stops Node admission, drains accepted requests, and then closes
  the SDK handler. That graceful close has no local timeout; the shared runtime
  lifecycle owns the configured tool timeout plus 10-second hard deadline and exits failed on expiry rather
  than returning a false cancellation for an admitted write.
- `WEAVER_ENCRYPTION_KEYS` is optional until an LLM connection is added. Its
  exact format is `<version>:<base64 32-byte key>[,<version>:<base64 32-byte key>...]`;
  versions are unique positive integers, every listed version may decrypt, and
  the highest version encrypts new/rotated credentials. `.env`, `.env.test`,
  and `.env.e2e` each need their own ring. If stored credentials reference a
  missing version, web, worker, and MCP refuse startup.
- `WEAVER_BOOTSTRAP_ADMIN_EMAIL`/`WEAVER_BOOTSTRAP_ADMIN_PASSWORD` (≥ 12 chars)/`WEAVER_BOOTSTRAP_ADMIN_NAME` (optional, default `Administrator`) drive `pnpm db:bootstrap-admin`, which atomically creates the first global Admin and normally skips existing users; `WEAVER_BOOTSTRAP_ADMIN_RECOVER=true` explicitly repairs only a sole matching verified Admin with no accounts, sessions, or memberships; unset in normal operation, set only for the one bootstrap run (locally, or via `docker compose run --rm -e ... migrations pnpm --filter @weaver/db bootstrap:admin`).
- Under a base path Better Auth's `baseURL` is
  `<origin><base path>/api/auth` (issuer and advertised endpoints); its web
  request adapter restores the prefix which Next strips before the router
  matches. Traefik sends `/.well-known/` to web with `addPrefix` and
  `<base path>/api/mcp` plus the protected-resource document to `mcp-server`.
  Explicit MCP resource and OAuth issuer overrides lose non-root trailing
  slashes so advertised and accepted paths cannot diverge.
- The Phase 4F OAuth migration is a lock-protected full cutover: every existing
  consent generation rotates and every existing access/refresh token is
  revoked. Before that cutover is applied to an existing database, stop web,
  worker, MCP, and all other database clients; the guarded database-package
  migration wrapper takes the writer-conflicting consent lock first and
  refuses a non-quiesced handoff. Migrations must finish before upgraded
  runtimes start; existing OAuth clients must authorize again.

## Knowledge jobs and LLM routing

- PostgreSQL 17 must have pgvector. The local dev container uses
  `pgvector/pgvector:pg17`; Compose pins `pgvector/pgvector:0.8.6-pg17-trixie`; host installations need matching pgvector server
  extension files before migrations. Apply `pnpm db:migrate`,
  `pnpm db:test:migrate`, and `pnpm db:e2e:migrate` to the three canonical
  database/data pairs; the migration enables `vector` in each database.
- Keyword-only operation is valid and still needs jobs:

  ```dotenv
  WEAVER_JOBS_ENABLED=true
  WEAVER_JOB_WORKER_CONCURRENCY=2
  WEAVER_KNOWLEDGE_RECONCILE_CRON="*/15 * * * *"
  WEAVER_ASSISTANT_RECONCILE_CRON="* * * * *"
  WEAVER_TASK_TICK_CRON="* * * * *"
  ```

| Variable                                          | Default / constraint                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEAVER_JOBS_ENABLED`                             | `true`; literal boolean string                                                                                                              |
| `WEAVER_JOB_WORKER_CONCURRENCY`                   | `2`; positive integer per queue worker                                                                                                      |
| `WEAVER_KNOWLEDGE_RECONCILE_CRON`                 | `*/15 * * * *`; nonempty pg-boss cron                                                                                                       |
| `WEAVER_ASSISTANT_RECONCILE_CRON`                 | `* * * * *`; assistant-run recovery, keep near the 30 s lease                                                                               |
| `WEAVER_TASK_TICK_CRON`                           | `* * * * *`; scheduled-task tick — claims due tasks, re-dispatches stale runs, expires abandoned leases (`weaver-scheduled-tasks`)          |
| `WEAVER_INGESTION_MAX_FILE_BYTES`                 | 52,428,800; validated 1,024..268,435,456                                                                                                    |
| `WEAVER_ARTIFACT_MAX_FILE_BYTES`                  | 268,435,456; validated 1,024..268,435,456; Files upload/read cap, independent of Imports                                                    |
| `WEAVER_PDF_TIMEOUT_MS`                           | 30,000; validated 5,000..120,000; Chromium render cap for document PDF export (`weaver-documents`)                                          |
| `WEAVER_CHROMIUM_PATH`                            | Optional Chromium executable for PDF export; unset uses the Playwright-managed browser, the web image sets `/usr/bin/chromium`              |
| `WEAVER_CHROMIUM_NO_SANDBOX`                      | `true`/`false` (default `false`); the web image sets `true` because the distro Chromium runs as the unprivileged `node` user in a container |
| `WEAVER_ONENOTE_READER_PATH`                      | Optional executable override; local default is the native reader's release target, Docker uses `/usr/local/bin/weaver-onenote-reader`       |
| `WEAVER_DOCUMENT_IMAGE_MAX_BYTES`                 | 10,485,760; validated 1,024..104,857,600; per-image cap for document image uploads (`weaver-documents`)                                     |
| `WEAVER_INGESTION_EXTERNAL_RATE_LIMIT_PER_MINUTE` | 60; validated 1..100,000; per-key in-process window for the external feed (Phase 5 §8)                                                      |
| `WEAVER_INGESTION_MAX_OCR_PAGES`                  | 50; validated 0..500, `0` disables OCR (spec §6)                                                                                            |
| `WEAVER_INGESTION_TMP_TTL_MINUTES`                | 60; validated 1..10,080; upload storage cleanup only, independent of ingestion job recovery                                                 |
| `WEAVER_WORKER_ROLES`                             | `knowledge,assistant,ingestion,tasks,git,wiki`; comma list, at least one valid role (spec §3.1)                                             |
| `WEAVER_MCP_OPERATION_LOCK_POOL_MAX`              | 16; independent MCP write locks, 1..128                                                                                                     |
| `WEAVER_ENCRYPTION_KEYS`                          | Versioned 32-byte base64 keys; required before storing provider credentials                                                                 |

- Assigning the two knowledge routes sends document chunks and end-user
  semantic search queries to their configured providers; entity text may be sent for
  embeddings. Table rows are not sent in Phase 3. Disclose this and verify the
  provider's retention/residency/training terms. Never log or store credentials,
  prompts, provider bodies, or source text in failures/usage.
- Web instrumentation starts the queue publisher only. The agent-worker owns
  every pg-boss consumer and the scheduled reconciler. Jobs retry up to five
  times with exponential backoff. General jobs expire after 15 minutes; AI
  enrichment is cancellation-aware, locally serialized per worker process, and
  uses a 24-hour lease. Worker concurrency is capped at 8 and provider timeout
  by the connection setting. Blocked configuration and invalid provider output do not spin. Restoring the same route automatically reopens blocked active-generation documents on reconciliation; incompatible generations and terminal validation failures require Maintainer retry/rebuild.
  Keyword search remains available without AI.
- Follow the canonical [key rotation procedure](../../../docs/setup.md#rotate-encryption-keys); restart web, worker, and MCP at both ring transitions.
- Verify installation without echoing URLs/keys: load the matching env file and
  query only `pg_extension.extversion` for `vector` and
  `to_regnamespace('pgboss') IS NOT NULL`. pg-boss can be initialized by a jobs-enabled publisher or worker; namespace
  existence alone does not establish that consumers have run. Do not dump `pgboss.job.data`, `env`, or provider responses.
  Copy the secret-safe commands from `docs/setup.md` rather than putting a
  credential-bearing URL directly on the command line.

- Shared job environment validation lives in `packages/config/src/jobs.ts`; both server and knowledge parsers reuse it. The shipped AUTH_SECRET placeholder is rejected.
- Playwright prepares database, pg-boss, Git and upload fixtures before starting application runtimes; its web command starts web only. `packages/config/src/testEnvironment.ts` also guards resets inside the test processes.
- Compose gives worker 45 seconds and MCP 135 seconds to stop; `tini -g` relays signals to the process group. Web retains native Next HTTP/`after` draining. Its pinned Next16 private close adapter (`apps/web/server-lifecycle.mjs`) then drains publisher/writer/database with bounded per-step cleanup; revalidate the adapter before changing Next versions. Web also receives 135 seconds of Compose grace. HSTS belongs to the edge operator.
- `WEAVER_MIGRATION_HANDOFF_TIMEOUT_MS` defaults to 600,000 (30,000..3,600,000) for the historical OAuth cutover barrier.
- `@weaver/ingestion`'s `@napi-rs/canvas` dependency (image decode/PDF page
  rendering) ships prebuilt musl binaries for `node:22-alpine`; the worker
  Dockerfile's `pnpm install --ignore-scripts` still works because the
  package needs no native build step at install time.

- External MCP uses the same encryption ring with distinct connection/approval
  AADs. All three runtimes call `assertExternalMcpSecretsDecryptable`; secret
  rotation includes active approval payloads using compare-and-swap.

- Remote instance transfer (`weaver-auth`'s peer OAuth clients,
  `weaver-admin`'s registry, "Send to another Weaver…" on documents/tables)
  needs no new environment variable. `RemoteInstanceConnection` tokens use the
  same encryption ring, AAD `remote-instance-connection`; all three runtimes
  call `assertRemoteConnectionSecretsDecryptable` at startup, and
  `pnpm secrets:rotate` (`rotateRemoteConnectionSecrets`) re-encrypts them
  alongside every other ring-protected secret.

- Outbound external MCP endpoint/auth/policy/timeout settings live in the database,
  configured per user at Account › MCP connections; they are distinct from the inbound
  `WEAVER_MCP_*` server settings. No external server is bundled or seeded. Browser
  acceptance uses a separate loopback counter fixture on port 4011, owned by
  Playwright with no dev server reuse; `WEAVER_E2E_EXTERNAL_MCP_PORT` changes only
  that synthetic port.

To run alongside development servers, set `PLAYWRIGHT_BASE_URL` (web),
`WEAVER_E2E_WORKER_PORT` (default `3101`), and `WEAVER_E2E_MCP_PORT` (default
`3200`) to free local ports. Playwright keeps readiness URLs, child listeners and
MCP resource URLs aligned; it still refuses server reuse and retains the guarded
`weaver_e2e` / `./data-e2e` pair.

- Project Git remotes use the same encryption ring with `project-git-remote`
  AAD bound to the configuration id. All three runtimes call
  `assertProjectGitRemoteSecretsDecryptable`; rotation preserves logical
  configuration revisions when only re-encrypting the same key. Web needs
  `ssh-keygen` for local key validation and workers need `git`/`ssh`; web and
  worker Docker images include OpenSSH. The `git` role runs both pushes
  (`project.git-sync`/`project.git-push`) and pulling existing remote content
  (`project.git-pull`); it is in default roles and Compose agent-worker, add it
  explicitly to custom role lists. Runtime details and retry/lease invariants
  live in `weaver-jobs` and `docs/setup.md`.

Production Compose explicitly pins NODE_ENV and sends HSTS at Traefik. AUTH_URL
is required for production and must use HTTPS except on loopback; never use the
container's HTTP service URL as the public origin. Runtime parseServerEnv ignores
SKIP_ENV_VALIDATION and always parses defaults. WEAVER_OUTBOUND_ALLOWED_ORIGINS
allows exact trusted private/HTTP origins for pinned provider, Docling and MCP
requests. External MCP connections of every user use it. Upload quota/free-space knobs are documented in .env.example; worker
/ready probes the queue database while /health remains liveness.

## Backups

`deploy/weaver-backup` takes a quiesced backup: `compose stop` of whichever of
web/agent-worker/ingestion-worker/mcp-server were running (never postgres) →
`pg_dump` → per-repository `git fsck --connectivity-only` → `tar` (any nonzero
status is fatal) → `compose start` of the same services (also from the EXIT
trap, never `up`) → `gzip -t` + `tar -tzf` → publish → prune. A repository
failing fsck still gets the pair published but fails the unit and skips
pruning. `scripts/backup-script.test.mjs` pins these decisions; nothing
exercises the script against a real host, and a restore rehearsal is manual.

Deployment-wide schedule ownership uses `WEAVER_ENABLED_WORKER_ROLES` (default
all roles), identically configured on every worker. Local `WEAVER_WORKER_ROLES`
must be a subset; registration rejects an excluded local role before any
schedule changes. Startup unschedules assistant/task/Git cron jobs only when
their role is disabled deployment-wide, preserving schedules belonging to
other split workers. Update both role lists and restart all workers when
disabling a role; queued work remains durable. See `docs/setup.md`.

## Operational review hardening

Upgrade accepts main only, pins deploy files and images to one resolved commit,
requires strict pull plus matching web revision and healthy workers. On success it
removes older Weaver image sets and keeps the new and the previous (rollback) set:
old sets keep their SHA tags, so `docker image prune` alone never frees them. Boot remains
offline-tolerant. Upgrade installation, reload and backup share `deploy.lock`;
reload recreates migrations/app services and leaves Postgres running. Hosts need
jq and util-linux flock. Worker readiness uses `/ready`. All pnpm runtime images
cache Corepack in world-readable `/usr/local/share/corepack` during the build.
PgBoss uses 2 publisher/4 worker connections; with Prisma 10 and Git locks 4 the
four-process maximum is 68 connections, against Compose Postgres 150. Leave room
for migrations, backup, diagnostics and administrative connections; each replica
adds its own pools. CI serializes releases, refuses existing version aliases,
updates cache aliases only from main, and executes the web lifecycle guard.

Published images carry no agent instructions, internal docs, deploy files or
Git data. `.dockerignore` excludes them from the context; in
`docker/web.Dockerfile` the `tools` target derives from `workspace` (deps +
`packages/` + generated Prisma client), never from `builder`, whose `COPY . .`
only feeds the standalone build. Every CI smoke test first fails on `.git`,
`.claude`, `.codex`, `.superpowers`, `CLAUDE.md`, `AGENTS.md`, `docs` or
`deploy` in the image's working directory, and builds pass
`--provenance=false` because the attestation records the Git remote. A command
meant for the `migrations` container must run from `packages/` alone.

`WEAVER_GIT_ALLOWED_SSH_TARGETS` grants exact private SSH host:port exceptions.
`@weaver/config/outboundSsh` validates all DNS answers and the Git transport pins
SSH Hostname to the selected approved IP while preserving HostKeyAlias (including
nonstandard ports). Defaults deny non-public destinations, including development
loopback; internal Git deployments must configure their explicit exceptions on
web and Git workers. Connection/authentication failures share NETWORK_ERROR for project members; the
`git.remote.push_failed`/`git.remote.pull_failed` diagnostic events carry the
real cause (`GitRemoteError.detail`: the denied target and setting, or SSH stderr).
Direct-listener auth keeps Better Auth's shared per-path rate-limit fallback;
proxy trust selects a trusted source header, never whether rate limiting exists.

Project machine writes use a separate content author (`services/contentAuthor.ts`); they never gain membership. Preserve the machine editor pair (`lastEditedByMachineKind`/`Id`, dual-writing `lastEditedByProjectKeyId` this release) and captured name when rebuilding, and clear the prior machine stamp on human edits/moves. Machine publishing flows through `projectApi/operations.ts` with operation→project locks and revision/idempotency guards. Operation locking has its own `WEAVER_PROJECT_API_OPERATION_LOCK_POOL_MAX` (1–128, default 2) so single-connection repository/application pools remain safe.

OIDC client credentials stored under SystemSetting `auth.oidc` participate in
startup decryptability checks in all three runtimes and `pnpm secrets:rotate`.
The credential uses AES-GCM AAD `oidc:system`; rotation preserves its settings
revision and authentication generation.
Only credential-envelope/key failures stop startup; malformed non-secret OIDC
fields fail OIDC closed while password login and unrelated runtimes remain usable.

## Review hardening invariants

Backups stop both running and restarting application writers, then verify no running/restarting/paused writer remains before pg_dump. Only a default-branch pipeline without a Git tag may publish latest runtime or cache aliases.
