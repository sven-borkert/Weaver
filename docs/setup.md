# Weaver — Local setup

Clean-machine walkthrough for developing Weaver. The short version lives in
CLAUDE.md §Local setup; this doc spells out each step and the
troubleshooting that goes with it.

## Prerequisites

- **Node 22+** (developed on Node 24).
- **pnpm 12** via corepack 0.34 or newer (older bundled corepack cannot start
  pnpm 12; run `npm i -g corepack@latest`):

  ```bash
  corepack enable && corepack prepare pnpm@12.14.0 --activate
  ```

- **PostgreSQL 17 with pgvector**, either through the recommended
  `pgvector/pgvector:pg17` Docker/Podman image or a host PostgreSQL whose
  server has the pgvector extension files installed. A newer host PostgreSQL
  may work, but the container and production-parity image stay pinned to 17.
- **Git 2.36+** on the host running web, worker, and MCP (batched reads use
  `git cat-file --batch -z`). Ubuntu 22.04 ships 2.34; install a newer one
  from `ppa:git-core/ppa`. The workspace shows a warning bar when Git is
  missing or too old.

## 1. Environment files

Weaver uses **three databases**, one per env file (CLAUDE.md "Three
databases" is authoritative — never point a test suite at the dev DB):

| File        | Database      | Git/data directory | Used by                                                          |
| ----------- | ------------- | ------------------ | ---------------------------------------------------------------- |
| `.env`      | `weaver`      | `./data`           | `pnpm dev`, `pnpm dev:web`, `pnpm dev:worker`, database commands |
| `.env.test` | `weaver_test` | `./data-test`      | `pnpm test:integration`, `pnpm db:test:migrate`                  |
| `.env.e2e`  | `weaver_e2e`  | `./data-e2e`       | `pnpm e2e`, `pnpm db:e2e:migrate`, `pnpm db:e2e:seed`            |

Create them:

```bash
cp .env.example .env
cp .env.example .env.test
cp .env.example .env.e2e
```

Then edit each file:

- `DATABASE_URL` — point `.env` at `weaver`, `.env.test` at `weaver_test`,
  `.env.e2e` at `weaver_e2e` (only the database name at the end of the URL
  differs). Fill the password placeholder once you know your DB password
  (step 2).
- `AUTH_SECRET` — generate a **separate** secret per file. Better Auth signs
  session cookies with it; rotating it signs everyone out.

  ```bash
  openssl rand -base64 32
  ```

- `WEAVER_DATA_DIR` — keep each database paired with the directory in the
  table. Integration and e2e resets delete both database rows and the paired
  Git repository tree.
  `WEAVER_GIT_LOCK_POOL_MAX` — bounded PostgreSQL advisory-lock settings for
  cross-process project Git mutations. The defaults are `10000`, `25`, and
  `4`; keep them unless local database latency requires a deliberate change.
- `WEAVER_PROJECT_API_OPERATION_LOCK_POOL_MAX` — optional, default `2`
  (1–128): a separate advisory-lock pool that serializes retries of the same
  project API operation before the project lock. See
  [docs/api/project-machine-api.md](api/project-machine-api.md).
- `WEAVER_MCP_RESOURCE_URL` — optional; defaults to `<AUTH_URL origin><base
path>/api/mcp`; must be `https://` off loopback; it is the audience of MCP
  access tokens.

`.env.test` and `.env.e2e` are gitignored just like `.env`; only
`.env.example` is committed.

## 2. Start PostgreSQL

**Option A — Docker container (recommended).** Fill the password in
`DATABASE_URL` first (any non-empty password; the script derives the
container password from the URL), then:

```bash
./start-database.sh
```

This starts a `weaver-postgres` container from `pgvector/pgvector:pg17`
matching `DATABASE_URL` (password, port, DB name are parsed from `.env`). Note:

- The container runs with `POSTGRES_USER=postgres`, so the URL's user part
  must be `postgres` (as in `.env.example`).
- It only creates the `weaver` database. Create the two test databases once:

  ```bash
  docker exec weaver-postgres psql -U postgres \
    -c 'CREATE DATABASE weaver_test;' -c 'CREATE DATABASE weaver_e2e;'
  ```

**Option B — host PostgreSQL.** Install the pgvector extension package for the
same PostgreSQL server first. For Homebrew PostgreSQL, install the `pgvector`
formula and ensure it targets the server selected by `PSQL` in the provisioning
script. Then run the script once; it idempotently creates the `weaver` role,
the three databases, and enables `vector` in each database:

```bash
./scripts/provision-databases.sh
```

The role password is generated into `.local-db-secret` (gitignored,
chmod 600). Use `postgresql://weaver:<that password>@127.0.0.1:5432/…` in
all three env files. The script assumes Homebrew psql at
`/opt/homebrew/opt/postgresql@18/bin/psql` and a superuser that may create
roles (adjust the `PSQL` path and the `-U` user at the top of the script if
your setup differs).

## 3. Install, migrate, seed

```bash
pnpm install                 # runs `prisma generate` via postinstall
pnpm db:migrate && pnpm db:test:migrate && pnpm db:e2e:migrate
pnpm db:seed
```

The three migration commands are deliberately separate: `.env` migrates
`weaver` + `./data`, `.env.test` migrates `weaver_test` + `./data-test`, and
`.env.e2e` migrates `weaver_e2e` + `./data-e2e`. The Phase 3 migration enables
pgvector and must be applied to all three pairs before their app or suite runs.
The migration also adds stored generated search columns and non-concurrent
indexes. On populated databases those DDL operations can lock their tables;
preflight table sizes and lock/statement timeouts, then schedule a maintenance
window instead of applying the migration during normal traffic.
`20260902090000_better_auth_organizations` deletes all pre-release users,
credentials, and memberships (projects and content are kept); in development
or test databases, re-run `pnpm db:seed` (or `pnpm db:e2e:seed`) afterwards.
`20260903090000_api_keys_mcp_oauth` adds the API-key and OAuth tables; it is
additive.

The root migration commands run the database package's guarded deploy wrapper.
When `20260906130000_oauth_generation_cutover` is pending on an existing
database, stop web, worker, MCP, and any other database clients first. The
wrapper takes `OauthConsent` in `EXCLUSIVE` mode as its first held relation
lock, waits for a pre-existing revocation, then refuses to continue unless the
database is quiesced before handing the lock to Prisma. Fresh databases and
databases where the cutover is already recorded use ordinary `migrate deploy`.
Do not invoke Prisma directly to bypass this precondition.

The seed creates `admin@weaver.local` plus four demo users
(`owner@`, `maintainer@`, `editor@`, `viewer@weaver.local`, password
`admin1234567` for all) and the Demo Project with memberships exercising
all four project roles. Seeds are idempotent upserts — safe to re-run. Users
are created through Better Auth (`@weaver/auth` `createCredentialUser`), so
the seed needs `AUTH_SECRET` from the same env file.

## 4. Run the app

```bash
pnpm dev                     # web + agent worker + mcp-server
pnpm dev:web                 # web only → http://localhost:3000
pnpm dev:worker              # agent worker only → 127.0.0.1:3101/health
pnpm dev:mcp                 # MCP runtime only → 127.0.0.1:3200/health
```

To run the production build locally, `pnpm build` first, then:

```bash
pnpm start                   # web + agent worker + mcp-server
pnpm start:web               # web only → http://localhost:3000
pnpm start:worker            # agent worker only
pnpm start:mcp               # MCP runtime only
```

Sign in with `admin@weaver.local` / `admin1234567`.

`pnpm dev` loads `.env` once and starts the three workspace runtimes through
Turborepo. The worker health endpoint returns
`{"status":"ok","runtime":"agent-worker"}` on loopback port 3101
(`WEAVER_WORKER_HEALTH_PORT`); the MCP runtime answers
`{"status":"ok","runtime":"mcp-server","version":"…"}` on loopback port 3200
(`WEAVER_MCP_PORT`). Set `WEAVER_MCP_RESOURCE_URL="http://127.0.0.1:3200/mcp"`
in `.env` so local MCP clients and token audiences point at it. `pnpm start`
starts the same three runtimes from the production build. Running only
`pnpm dev:web` or `pnpm start:web` leaves durable jobs queued until an agent
worker starts: the knowledge index stays "Building" and Rebuild appears to do
nothing.

### Knowledge-index and LLM configuration

Keyword indexing and table-metadata search work without an AI provider. This
is the complete keyword-only example:

```dotenv
WEAVER_JOBS_ENABLED=true
WEAVER_JOB_WORKER_CONCURRENCY=2
WEAVER_KNOWLEDGE_RECONCILE_CRON="*/15 * * * *"
WEAVER_ASSISTANT_RECONCILE_CRON="* * * * *"
WEAVER_TASK_TICK_CRON="* * * * *"
```

Knowledge and provider server variables are:

| Variable                          | Meaning / default                                                                                                                                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEAVER_JOBS_ENABLED`             | Let the agent worker consume pg-boss jobs; defaults to `true`.                                                                                                                                                                                                                                 |
| `WEAVER_JOB_WORKER_CONCURRENCY`   | General per-queue concurrency, `1`–`8`; defaults to `2`.                                                                                                                                                                                                                                       |
| `WEAVER_KNOWLEDGE_RECONCILE_CRON` | Cron for knowledge repair reconciliation; defaults to every 15 minutes.                                                                                                                                                                                                                        |
| `WEAVER_ASSISTANT_RECONCILE_CRON` | Cron for assistant-run recovery (expired leases, unpublished runs); defaults to every minute. Keep it close to the 30 s attempt lease — a stranded run blocks its conversation until it is reconciled, worst case roughly 100 s once pg-boss's own polling intervals stack on top of the cron. |
| `WEAVER_TASK_TICK_CRON`           | Cron for the scheduled-task tick that claims due tasks, re-dispatches stale runs, and expires abandoned leases; defaults to every minute.                                                                                                                                                      |
| `WEAVER_ENCRYPTION_KEYS`          | Required before adding LLM connections; `<version>:<base64 32 bytes>[,…]`; the highest version encrypts. Generate a key with `openssl rand -base64 32`; `.env`, `.env.test`, and `.env.e2e` each need their own value.                                                                         |
| `WEAVER_AUTH_RATE_LIMIT_ENABLED`  | Overrides Better Auth's sign-in/API rate limiting; defaults to on for production builds and off otherwise. The e2e config sets `false`.                                                                                                                                                        |
| `WEAVER_WORKER_ROLES`             | Which pg-boss consumers a worker process registers; defaults to `knowledge,assistant,ingestion,tasks,git,wiki`. Compose runs `knowledge,assistant,tasks,git,wiki` and `ingestion` as two containers built from one image.                                                                                |
| `WEAVER_INGESTION_MAX_OCR_PAGES`  | Vision (OCR) calls per file for scanned PDF pages and images; defaults to `50`, validated `0`–`500`. `0` disables OCR.                                                                                                                                                                         |

### Configure LLM providers

1. Set `WEAVER_ENCRYPTION_KEYS`, restart web, worker, and MCP, and sign in as a
   global Admin.
2. Open **Administration › Settings › AI** and add a connection: OpenAI, Anthropic, an
   OpenAI-compatible endpoint, or a local LM Studio (`http://127.0.0.1:1234`)
   or Ollama (`http://127.0.0.1:11434`) server. The local servers need no API
   key.
3. Saving the connection tests it and opens **Import models**, which lists
   the models the provider reports with their context window, max output
   tokens, and capabilities; import the ones you need and adjust anything
   afterwards with **Edit** (or declare models by hand with **Add model**).
   A model assigned to knowledge embeddings may declare any size from 1 to
   4,000 dimensions; sizes 256, 384, 512, 768, 1,024, 1,536, 2,048, 2,560,
   3,072, and 4,000 are indexed (HNSW), other sizes fall back to exact search.
   A Matryoshka model may be set to any size up to its native size. For
   Ollama the reported context is the model's maximum; the server's own
   `num_ctx` setting may be lower.
4. Assign the assistant, knowledge-extraction, and knowledge-embedding routes.
5. Use **Test** on each connection and model before relying on it.

To use Ollama's `qwen3-embedding:4b` at a smaller size, import its native
2,560 dimensions, then **Edit** the declared model to the size you want and
enable **Matryoshka / resizable**. Run **Test** and require the requested
result, then assign it to the knowledge-embedding route. Saving a new size on
the routed embedding model first embeds one sample to confirm the model
still produces that size, then re-embeds every project automatically while
keeping its knowledge graph — no Rebuild step needed (Rebuild re-extracts
everything from source).

Weaver sends document content and end-user semantic search queries to the
providers assigned to the knowledge routes. Choose endpoints and
data-processing terms appropriate for that content. Credentials, prompts,
provider responses, and document/source text are not stored in usage records
or written to application logs.

### Configure import parsing

Route a chat model on **Import parsing** in **Administration › Settings › AI** so
Imports can transcribe scanned PDF pages and images; declare the **Vision**
capability on that model. Without a vision-capable route assigned, those
scans stay blocked with a pointer back to this page. Optionally enter a
docling-serve base URL under the **Document parsing** card and press **Test
connection**; Docling is preferred for PDF and image uploads whenever it is
reachable and is never part of `docker-compose.yml`.

### Connect an external MCP service

Outbound connections are configured at **Administration › Connections**. They are
separate from Weaver's inbound MCP endpoint and its `WEAVER_MCP_*` variables.
No external server or service credential is bundled or seeded.

1. Apply `pnpm db:migrate`, configure the encryption ring, and restart the web,
   worker and MCP runtimes. Pending approval arguments use the same ring with
   distinct encryption context; retain all required key versions during rotation.
2. Add an HTTP(S) MCP endpoint, optionally a bearer token, timeout (5–120 seconds)
   and tool-use policy. A new connection starts disabled with no grants or enabled
   tools. Credentials are write-only. "Accept any certificate" skips TLS chain,
   expiry, and hostname validation for that connection only — leave it off unless
   the endpoint's certificate can't otherwise be validated and you already trust
   the network path to it.
3. Use **Test and discover**, review each tool's description/schema, choose Read or
   Write, and enable only the reviewed tools you intend to expose. Changed or
   removed definitions become unavailable until reviewed again.
4. Grant the relevant projects and enable the connection. Grants permit invocation
   only by members with the required content permissions; they do not constrain
   the shared service account's authority on the remote system.
5. In the assistant, explicitly select tools under **External connections** for the
   message's scope. Ask mode waits for approval of the exact arguments; automatic
   mode also permits authorized writes without a second prompt. Selected tools can
   send conversation data to the service, and results can reach the AI provider.
6. Project or Account task editors accept up to five required automatic read inputs
   with literal JSON arguments or explicit report-period bindings. Failed required
   inputs preserve the prior report and show their status in run history.

The adapter supports negotiated MCP compatibility including `2024-11-05`, JSON and
finite Streamable HTTP responses; it does not offer stdio, SSE-only fallback,
personal OAuth, sampling, elicitation or automatic resource ingestion. After a
lost response, check the remote service before deliberately retrying: Weaver never
automatically replays an admitted external call. External raw arguments/results and
provider bodies for affected runs are excluded from diagnostics.

For synthetic browser acceptance, apply `pnpm db:e2e:migrate` and obtain the current
Tier 3 consent before running the guarded `RUN_FULL_TESTS=1 pnpm e2e` command.
Playwright owns a fresh loopback counter MCP fixture on port 4011 (optional
`WEAVER_E2E_EXTERNAL_MCP_PORT` override); it never reuses a dev connection or calls
a live service. The root Node tests check the fixture's state and disconnect rules.

To run alongside development servers, set `PLAYWRIGHT_BASE_URL` (web),
`WEAVER_E2E_WORKER_PORT` (default `3101`), and `WEAVER_E2E_MCP_PORT` (default
`3200`) to free local ports. Playwright keeps readiness URLs, child listeners and
MCP resource URLs aligned; it still refuses server reuse and retains the guarded
`weaver_e2e` / `./data-e2e` pair.

### Automatic project Git pushes

In Project › Settings, an Owner saves an SSH remote URL and branch (default
`main`), uploads a named private key, and enables automatic pushes. Use a key
with write access to that repository; unencrypted OpenSSH and PEM keys are
supported, up to 64 KiB. Weaver displays the name, SHA-256 fingerprint and upload
time but never offers a private-key download. Keys can be replaced or deleted;
deleting one pauses future pushes. An already admitted attempt may finish.

Web needs `ssh-keygen` for upload validation; workers need `git` and `ssh`.
The web/worker Docker images include OpenSSH. Local setups must have these
executables on the standard system path. Configure `WEAVER_ENCRYPTION_KEYS` in
all runtimes before uploading a key; Git credentials participate in startup
validation and `pnpm secrets:rotate` alongside existing encrypted credentials.

At least one enabled worker must include the `git` role. The default roles and
Compose agent-worker include it; deployments with an explicit older
`WEAVER_WORKER_ROLES` must add `git` and restart that worker. Discovery runs about
every minute. Failures retry after 1, 5, 15, then 60 minutes, capped at 60 minutes;
Settings shows status and offers Push now to make the next check immediately due.
This is a one-way push of committed history, including the existing
`project.json`; unsaved edits and database-only data are not exported.

The first SSH host key is trusted and pinned; later changes are rejected.
Verify the server independently before reconnecting after a host-key change.
A new remote address clears the pin; replacing a private key does not. Use an
empty destination branch or one sharing Weaver's existing history. Diverging
remote commits and branch protection can reject a push; Weaver never force-pushes
or pulls remote content into the project.

### Rotate encryption keys

Append a higher version and a newly generated 32-byte key to
`WEAVER_ENCRYPTION_KEYS`, then restart web, worker, and MCP with the complete
ring before running `pnpm secrets:rotate`. Confirm rotation succeeds before
removing the old version. Restart all three runtimes with the retained ring.
Each runtime captures its ring at startup, so leaving any process on the old
ring can prevent decryption or create new records with the retired key.

The web runtime starts only the durable publisher through
`apps/web/src/instrumentation.ts`; it never registers pg-boss consumers. The
separate `apps/agent-worker` runtime owns every knowledge handler and scheduled
reconciler. Successful document/table commits enqueue identifier- and
Git-SHA-only jobs, and reconciliation repairs missed enqueue or stale projection
state. pg-boss retries retryable work up to five times with exponential
backoff. Configuration/validation failures remain safely visible without a
retry loop; after correcting configuration, a Maintainer can use the knowledge
retry/rebuild API. Keyword search remains available when knowledge routes are
unassigned or a provider is unavailable. General jobs expire after 15 minutes;
AI enrichment
has one provider call in flight per worker process, propagates cancellation,
and uses a 24-hour lease (pg-boss's maximum) with a 23-hour provider-call
deadline that ends a runaway document as a retryable failure.
Embedding requests are sized from the measured speed of the embedding
connection (one input until measured, then half its timeout), so a slow local
CPU model needs only a generous connection timeout (up to 120 s); searches wait
at most 5 s for the query embedding before falling back to keyword results.
With diagnostics at `standard`, `knowledge.document.embedded` events show each
document's request count, largest request, characters and duration, and
`knowledge.search.degraded` warnings show search fallbacks (Administration ›
Diagnostics or the `list_diagnostic_events` MCP tool).

After migrations and one agent-worker startup, confirm installation without
printing the database URL or any AI key:

```bash
pnpm exec dotenv -e .env -- node --input-type=module -e '
import { Client } from "pg";
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows: [status] } = await client.query(`
  SELECT (SELECT extversion FROM pg_extension WHERE extname = $1) AS "vectorVersion",
         to_regnamespace($2) IS NOT NULL AS "pgBossInstalled"
`, ["vector", "pgboss"]);
console.log(status);
await client.end();
'
```

This prints only the pgvector version and whether the worker has initialized
pg-boss; the connection string stays in the child process environment instead
of a command-line argument. Do not diagnose this setup with `env`, `printenv`,
`echo "$DATABASE_URL"`, job payload dumps, or logged provider responses.

## 5. One-time for e2e

```bash
pnpm exec playwright install chromium
```

The same Chromium renders document PDF exports locally (`playwright-core` finds
it through the Playwright browser registry). Without it the Export as PDF button
is disabled and explains why; the Docker image ships its own Chromium.

```sh

```

## OIDC sign-in (Authentik)

Weaver supports one optional OpenID Connect provider alongside password login.
Configure the provider under **Administration > Settings > OIDC**; users see its display name on the
login page. Any user authorized for this application at the identity provider
can create a Weaver account by signing in. Restrict application access in
Authentik to the intended users or groups.

1. In Authentik, create an application with an **OAuth2/OpenID Connect**
   provider and a **confidential** client. Enable the `openid`, `profile`, and
   `email` scope mappings and use a signing key. The ID token must contain a
   stable `sub`, an email, and the boolean `email_verified: true`. Configure
   email verification in Authentik before asserting that claim.
2. Set an exact, strict redirect URI:
   `https://weaver.example.com/api/auth/callback/oidc` at the origin root, or
   `https://weaver.example.com/weaver/api/auth/callback/oidc` under `/weaver`.
   The final `oidc` is Weaver's fixed provider ID; it is independent of the
   Authentik application slug and the button label.
3. Open **Administration > Settings > OIDC**. Enter the discovery URL,
   client ID, client secret, and display name. Enable OIDC sign-in. The form
   shows the exact callback URL to register with your provider.
4. Choose **Test connection** to fetch discovery metadata and signing keys using
   the entered URL. The result shows the issuer, endpoints, scopes, signing
   algorithms, PKCE support, and client authentication methods. It does not save
   settings or verify the client secret; a full sign-in is needed for that.
5. Choose **Save**. Weaver validates metadata again, encrypts the client secret
   with `WEAVER_ENCRYPTION_KEYS`, and applies the settings on the next login
   request without a restart or rebuild. Blank secret retains the saved secret;
   entering a value replaces it. Disable and Save to stop new OIDC logins.

Discovery, token exchange, and signing-key requests use the existing outbound
policy. Public HTTPS origins need no allowlist entry. For private identity
providers, add every private origin used by discovery, token, and JWKS endpoints
to `WEAVER_OUTBOUND_ALLOWED_ORIGINS` and recreate the web container. Test uses a
five-second deadline and bounds discovery/JWKS JSON to 256 KiB each. Only
asymmetric signing, PKCE S256, and confidential-client basic/post authentication
are supported. Metadata alone does not establish verified-email support.

Existing deployments can continue using these environment variables while no
saved OIDC settings exist:

```dotenv
WEAVER_OIDC_DISCOVERY_URL="https://auth.example.com/application/o/weaver/.well-known/openid-configuration"
WEAVER_OIDC_CLIENT_ID="<Authentik client ID>"
WEAVER_OIDC_CLIENT_SECRET="<Authentik client secret>"
WEAVER_OIDC_DISPLAY_NAME="Authentik"
```

The first three must be set together; the display name defaults to
`OpenID Connect`. Environment edits require web-container recreation, but no image
rebuild. The first UI Save takes ownership of OIDC configuration; a saved disabled
configuration also overrides environment values. Client secrets are never shown
again and participate in `pnpm secrets:rotate`. Keep `AUTH_SECRET` separately:
Better Auth uses it to encrypt the upstream access/refresh tokens.

Discovery requires HTTPS; HTTP is accepted only on loopback for development.
`AUTH_URL` is Weaver's public origin, and the configured application base path is
added to the callback automatically. Never use `NEXT_PUBLIC_*` variables or put
the client secret in a URL. Changing a material setting invalidates OIDC flows
already waiting at the provider; users start a new login. Label-only edits and
credential re-encryption preserve those flows. The first UI save of environment
configuration also requires users waiting at the provider to restart their login.

New OIDC accounts have the `User` global role and no shared-project membership.
Weaver creates the usual personal workspace on first entry. OIDC group or role
claims do not grant Weaver administration or project access. A verified matching
email links to an existing account and preserves its name, role, memberships,
bans, and any required local password change. Later logins identify the account
by issuer plus subject, rather than email. New OIDC accounts have no local
password; manage their credentials at the identity provider.

Keep the issuer/subject stable when editing provider settings. Replacing the
identity provider requires an intentional account migration; changing the display
name does not change identity. Upstream access and refresh tokens are encrypted using `AUTH_SECRET`
by Better Auth; retain that secret across restarts. ID tokens remain signed
JWTs stored in the account row. Signing out clears the Weaver
session and leaves the Authentik session available to other applications.
Authentik logout or deactivation does not automatically revoke existing Weaver
sessions; use Weaver's account deactivation/session revocation when immediate
revocation is needed.

If discovery fails or lacks verification metadata, Save leaves the previous
configuration intact and Test reports the problem. Password login and session
reads do not depend on discovery. Environment fallback discovery failures can be
retried without a process restart. Callback failures return to the login page
with a generic error. For redirect mismatches, compare the provider's registered
URI against the public URL including the base path, `/api/auth/callback/oidc`,
and HTTPS. This login callback is separate from Weaver's MCP OAuth endpoints.

Provider references: [Authentik OAuth2 provider](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/)
and [Better Auth Generic OAuth](https://better-auth.com/docs/beta/plugins/generic-oauth).

## Troubleshooting

- **`require-env: ...` refuses to run a `db:*`/test/e2e command.** The root
  scripts go through `scripts/require-env.mjs`, which requires the env file
  to exist and to name the exact database/data-dir pair from the table above,
  and rejects a shell `DATABASE_URL`/`WEAVER_DATA_DIR` that differs from the
  file (the integration harness TRUNCATEs every table, so a wrong pair would
  wipe dev data). Recreate or fix the file, or unset the shell variable —
  never bypass the guard by calling `dotenv`/`vitest`/`playwright` directly.
- **Worker health succeeds but jobs do not advance.** Confirm the worker was
  started with the same `.env`, database, and `WEAVER_DATA_DIR` as web and that
  `WEAVER_JOBS_ENABLED=true`; then use the secret-safe pg-boss check above.
- **Documents or tables fail with `git cat-file exited with 129`.** The
  host Git is older than 2.36 (the workspace also shows a warning bar).
  Upgrade Git; web picks up the new version without a restart.
- **A Git-backed write reports that the repository is busy.** Another process
  holds the project advisory lock longer than `WEAVER_GIT_LOCK_TIMEOUT_MS`.
  Inspect the web/worker lifecycle and database health; do not bypass the lock
  or mutate the repository directly.
- **Stale Prisma client after switching branches or editing the schema.**
  Run `pnpm install` (its `postinstall` regenerates
  `packages/db/generated/prisma`) or `pnpm db:generate` directly. Application
  and shared code imports through `@weaver/db`, never `@prisma/client`.
- **Port already in use when starting the DB container.** Another Postgres
  (host install or a container from a different project) occupies 5432.
  Either stop it, or change the port in all three `DATABASE_URL`s and pass
  the same port to the container (`start-database.sh` parses it from
  `.env`).
- **`next dev` adds a block to CLAUDE.md.** When `next dev` detects an AI
  coding agent, it upserts a managed `<!-- BEGIN:nextjs-agent-rules -->`
  block; because `AGENTS.md` is a symlink to `CLAUDE.md`, the block is
  appended to `CLAUDE.md`. This is intentional Next.js behavior (it writes
  through the symlink once, then sees the block as present). Commit the
  block with your work rather than reverting it, and keep `AGENTS.md` a
  symlink.
- **Startup fails with `encrypted with key version(s) …`.** The ring lost a
  version still referenced by stored credentials; restore it or rotate with
  both versions present.
- **Auth requests rejected as untrusted origin.** Better Auth validates the
  request origin against `AUTH_URL`. Production requires the public HTTPS
  origin; loopback HTTP remains available for local acceptance runs. Cookies
  are explicitly secure for HTTPS, and trusted origins use this configuration.
- **Knowledge status stays keyword-only.** Confirm that enabled models are
  assigned to both knowledge routes in **Administration › Settings › AI**, use their
  connection/model tests, and restart the worker after repairing missing
  encryption keys; never paste keys or provider bodies into logs.
- **Jobs are not advancing.** Confirm `WEAVER_JOBS_ENABLED=true`, then use the
  safe pg-boss schema check above. Reconciliation will recover missed enqueue
  work; Maintainers can retry safe failed items after fixing configuration.
- **OAuth authorize fails with `invalid_target`.** The configured
  `WEAVER_MCP_RESOURCE_URL` and the client's `resource` parameter differ, or
  the `OauthResource` row is missing after a manual database reset — restart
  the web app (the provider re-seeds it).

## Run from registry images

GitLab CI builds four application images plus three build-cache repositories
on every push to `main` and on tags (`.gitlab-ci.yml`,
`deploy/ci/build-images.sh`):

| Image    | Contents                                                            |
| -------- | ------------------------------------------------------------------- |
| `tools`  | Workspace packages with the Prisma CLI: migrations, admin bootstrap |
| `web`    | Next.js standalone server                                           |
| `worker` | agent-worker and ingestion-worker (one image, two roles)            |
| `mcp`    | MCP server                                                          |

No image carries agent instructions (`CLAUDE.md`, `.claude/`, `.codex/`),
`docs/`, `deploy/` or the Git repository: `.dockerignore` keeps them out of
the build context, `tools` is built from the workspace packages alone, and the
CI smoke tests fail when one of those paths appears in an image. Images are
pushed without provenance attestations, which would record the Git remote.

The three build-cache repositories (`onenote-reader-build`, `worker-build`,
`mcp-build`) hold intermediate build stages as `:latest` only; they speed up
later builds and are never part of the running stack.

Tags: `latest` and `<version>` follow `main`; `<short sha>` is on every
published build; `<tag>` for git tags. The web image is built for
`NEXT_PUBLIC_BASE_PATH=/weaver`; another base path needs a rebuild with the
pipeline variable `WEAVER_BASE_PATH` changed.

Set `WEAVER_IMAGE_PREFIX` to your registry path, for example
`registry.example.com/weaver`. A private registry needs `docker login` with a
token that can read images.

The generic single-host example is
[`deploy/examples/docker-compose.yml`](../deploy/examples/docker-compose.yml)
with [`deploy/examples/web.env.example`](../deploy/examples/web.env.example):
PostgreSQL, migrations, web on a published port, both workers and MCP, one
`./data` directory, no reverse proxy. Copy `deploy/examples/docker-compose.yml`
and `deploy/examples/web.env.example` (as `web.env`) from the repository into
an empty directory, then:

```sh
mkdir weaver && cd weaver
# copy in docker-compose.yml and web.env from the repository, as above
umask 077 && openssl rand -hex 32 > pg_password
mkdir -m 0750 data && chown 1000:1000 data
# edit web.env: DATABASE_URL password = pg_password, AUTH_SECRET, WEAVER_ENCRYPTION_KEYS, AUTH_URL
docker login registry.example.com
docker compose --env-file web.env up -d
```

Then create the first Admin once `migrations` has exited 0:

```sh
docker compose --env-file web.env run --rm -e WEAVER_BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
  -e WEAVER_BOOTSTRAP_ADMIN_PASSWORD="$(openssl rand -base64 24)" \
  migrations pnpm --filter @weaver/db bootstrap:admin
```

Upgrade with `docker compose --env-file web.env pull && docker compose --env-file web.env up -d`;
pin a release with `WEAVER_IMAGE_TAG=<version>` in `web.env`. Local images are
still built with `docker compose -f docker-compose.yml -f docker-compose.build.yml build` from
a checkout.

## Production (docker-compose parity)

[`deploy/README.md`](../deploy/README.md) is the install, upgrade, backup and
restore runbook for a host behind Traefik. Every Compose command passes
`--env-file ${WEAVER_DEPLOY_ROOT}/web.env`, which supplies both the container
environment and the host values interpolated into `docker-compose.yml`:

| Variable                                   | Default             | Purpose                                                       |
| ------------------------------------------ | ------------------- | ------------------------------------------------------------- |
| `WEAVER_DEPLOY_ROOT`                       | `/srv/weaver`       | Holds `web.env`, `pg_password`, `postgres_data/`, and `data/` |
| `WEAVER_PUBLIC_HOST`                       | required            | Traefik `Host(...)` match; must be the `AUTH_URL` host        |
| `WEAVER_BASE_PATH`                         | `/weaver`           | Web build/runtime base path and every Traefik path rule       |
| `WEAVER_TRAEFIK_NETWORK`                   | `ingress`           | External Docker network shared with Traefik                   |
| `WEAVER_TLS_CERTRESOLVER`                  | `letsencrypt`       | Traefik certificate resolver for all three routers            |
| `WEAVER_IMAGE_PREFIX` / `WEAVER_IMAGE_TAG` | `weaver` / `latest` | Which images the stack pulls                                  |

Files:

- `docker/web.Dockerfile` — multi-stage web build (deps → builder → tools →
  runtime); builds with `NEXT_PUBLIC_BASE_PATH` (Compose passes
  `WEAVER_BASE_PATH`), Next standalone output (`BUILD_STANDALONE=1`), and
  healthcheck on `<base path>/api/health`.
- `docker/worker.Dockerfile` — private agent-worker runtime with Git/OpenSSH, generated
  Prisma client, signal forwarding through `tini`, and no web/test payload.
- `docker/mcp.Dockerfile` — standalone MCP runtime with Git, generated Prisma
  client, signal forwarding through `tini`, and no web/test payload.
- `docker-compose.yml` — project `weaver` with six services from the registry
  images (`docker-compose.build.yml` adds the builds):
  - `postgres` (`pgvector/pgvector:0.8.6-pg17-trixie`, pinned with its base OS
    so glibc collations cannot drift under existing data; password via the
    `pg_password` file secret, healthcheck),
  - `migrations` (one-shot guarded Prisma migration deploy from the `tools`
    image),
  - `web` (the app; Traefik serves it under the base path on the external
    Traefik network, plus the issuer's own
    `/.well-known/oauth-authorization-server<base path>/` discovery path —
    never the host-wide `/.well-known/` prefix, which other apps may share),
  - `agent-worker` (internal network only; healthcheck on
    `http://127.0.0.1:3101/health`),
  - `ingestion-worker` (same image, `WEAVER_WORKER_ROLES=ingestion`; internal
    network only; healthcheck on `http://127.0.0.1:3102/health`; parses
    uploads on its own container so OCR calls cannot starve assistant runs),
  - `mcp-server` (MCP runtime; Traefik routes `<base path>/api/mcp` and its
    protected-resource document to it; healthcheck on
    `http://127.0.0.1:3200/health`).

Web, worker, and MCP server load the same `web.env`, connect to the same
PostgreSQL service, and bind the same host data directory at `/data`. This
shared storage plus the database advisory lock is the supported single-host
consistency model. Web and MCP join the external Traefik network; neither
runtime publishes its container port directly.

For an upgrade that has not yet applied the Phase 4F authority cutover, quiesce
the old runtimes before starting the one-shot migration service:

```bash
docker compose stop web agent-worker ingestion-worker mcp-server
docker compose run --rm migrations
docker compose up -d
```

Close other sessions using the Weaver database as well. The migration wrapper
fails with the remaining client count instead of attempting the cutover under
traffic.

Web sets Better Auth cookies named `weaver.*` (`__Secure-weaver.*` over
HTTPS) with `Path` equal to the base path, so apps sharing the hostname never
receive or overwrite Weaver sessions.

### First Admin on a deployed instance

Public sign-up and the admin API surface are disabled, so the first global
Admin on a fresh deployment is created by an operator-run command after the
`migrations` service has completed:

```bash
docker compose run --rm \
  -e WEAVER_BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
  -e WEAVER_BOOTSTRAP_ADMIN_PASSWORD=at-least-twelve-characters \
  migrations pnpm --filter @weaver/db bootstrap:admin
```

Locally, run `pnpm db:bootstrap-admin` instead (reads
`WEAVER_BOOTSTRAP_ADMIN_EMAIL`/`WEAVER_BOOTSTRAP_ADMIN_PASSWORD`/
`WEAVER_BOOTSTRAP_ADMIN_NAME` from `.env`). Both are a no-op once any user
exists. User and credential creation is atomic. To recover a legacy interrupted
bootstrap, explicitly set `WEAVER_BOOTSTRAP_ADMIN_RECOVER=true` for this command
and use the original email. Recovery requires the sole user to be a verified,
unbanned Admin with no accounts, sessions, or memberships; it does not reset an
existing login. Unset the recovery flag and bootstrap password afterward.

Once the first Admin exists, create every additional account inside the
application at **Administration › Users** (create sets an initial password
shown once; the new account must change it at first sign-in), not by seeding
or direct database writes — `pnpm db:seed`/`pnpm db:e2e:seed` remain for the
throwaway dev/test/e2e databases only.

### Connecting MCP clients

The MCP endpoint is `WEAVER_MCP_RESOURCE_URL` (default
`<AUTH_URL><base path>/api/mcp`; `https://host/weaver/api/mcp` under the
compose base path, `http://127.0.0.1:3200/mcp` locally). Protocol revision
`2026-07-28` and stateless 2025-era Streamable HTTP are supported, including
clients using the `initialize` handshake. Explicit MCP-resource and issuer URLs are canonicalized by
removing non-root trailing slashes; configure clients with the advertised
canonical URL.

- Discovery: `GET <origin>/.well-known/oauth-protected-resource<resource path>`
  (served by the mcp-server) names the authorization server
  `<AUTH_URL><base path>/api/auth`, whose RFC 8414 document is
  `<origin>/.well-known/oauth-authorization-server<base path>/api/auth`.
- OAuth clients identify via Client ID Metadata Documents (HTTPS `client_id`
  URLs, `mcp-2026-07-28` profile) and use authorization code + PKCE with the
  `resource` parameter; DPoP-bound tokens are honoured. Review or revoke a
  client under the user menu → Connected apps.
- Personal API keys authenticate as `Authorization: Bearer wvr_…` (user menu →
  API keys); write tools appear only for keys created with "Edit content
  directly".
- Read tools (for credentials with `content:read`), three `weaver://` resource
  templates, and seven direct-write tools (for credentials with
  `content:write`): `create_document`, `update_document`, `patch_document`,
  `create_table`, `update_table_schema`, `update_table_rows`, and
  `change_table`. Every write requires an `idempotencyKey`; only
  `update_document`, `patch_document`, `update_table_schema`,
  `update_table_rows`, and `change_table` require the last-read
  `baseCommitSha`.
- Scope membership is resolved independently from read/write capability and
  capped to the 100 most recently updated allowed projects; each operation
  still enforces its own capability. Capped table/entity resources remain
  valid JSON and expose an explicit truncated envelope and metadata.
- A write timeout or incoming HTTP abort cancels work only before its
  irreversible Git boundary. Authorized writes pass that abort to the write
  cooperatively while shielding independent SDK transport teardown. Once the
  boundary is crossed the request waits for the real commit outcome, so a
  terminal `CANCELLED` can never be followed by a late commit. Read calls keep
  normal transport cancellation.
- MCP shutdown immediately stops new request admission, drains already
  accepted requests, then closes the SDK handler. The graceful drain has no
  separate local timeout; the runtime's shared watchdog (configured tool timeout plus ten seconds) is
  the hard bound and exits unsuccessfully if a request cannot finish.

Tune `WEAVER_MCP_*` in `.env.example` for limits and timeouts.

The Phase 4F OAuth migration is a one-time full authority cutover, not an
in-place preservation of existing grants. It locks the consent/access/refresh
tables, rotates every existing consent generation, and revokes every existing
access and refresh token. Use the quiesced upgrade sequence above and run the
one-shot `migrations` service to completion before starting upgraded web or MCP
containers; every OAuth client connected before the upgrade must authorize
again. Personal API keys are unaffected.

`WEAVER_AUTH_TRUST_PROXY` separately controls web sign-in rate limiting and defaults
to `false`. Compose enables it for the private web listener behind Traefik and
uses only the proxy-written `X-Real-IP`. Keep Traefik
`forwardedHeaders.insecure` disabled and configure trusted upstream proxies
explicitly; never enable this setting on a directly reachable web listener.
With no trusted IP source, Better Auth keeps rate limiting enabled and uses a
shared per-path bucket. Direct-listener sign-ins therefore share the login limit;
client-supplied forwarding headers cannot create fresh buckets.

`WEAVER_MCP_TRUST_PROXY` defaults to `false`. The supplied Compose service is
the narrow exception: it has no published port, accepts public traffic through
one controlled Traefik hop, and therefore opts in so the runtime may use
Traefik's right-most appended `X-Forwarded-For` address for anonymous rate
limits. Leave it `false` for direct listeners or any topology that does not
provide that exact trust boundary.

### Reading OneNote notebooks

Upload OneNote `.onepkg` or `.one` files to a project's **Files** page. The
assistant and MCP clients can use `get_artifact_overview`, `read_onenote` and
`search_artifact_text` to inspect the notebook. `read_onenote` supports `sections`,
`pages`, `search` and `page` actions; reuse returned cursors unchanged with the
same inputs. The first read queues background preparation, so report that status
and read again after it completes. A failed preparation can be retried with
`retry: true`. The agent worker must run with its `ingestion` role. The reader
returns content only; use the existing document creation tools to turn it into
Weaver documents.

For local development, install Rust using [rustup](https://rustup.rs/) and run
`pnpm notebook:build` once, and again after changing the native reader. The build
uses the checked-in Cargo lockfile; Rust 1.98.1 is the tested toolchain. The worker
Docker image includes the reader automatically. To use a binary installed
elsewhere, set `WEAVER_ONENOTE_READER_PATH` to its absolute path. Web and MCP
processes do not need Rust or the executable.

`WEAVER_ARTIFACT_MAX_FILE_BYTES` controls Files uploads and reads independently
of Imports (default and maximum 536870912 bytes / 512 MiB, the OneNote reader's
source limit; minimum 1024). Originals
still share the project's storage quota. Notebook preparation is bounded to five
minutes, 1 GiB resident memory, 512 MiB expanded input and 512 MiB derived output.
The tools return text, table rows and image/attachment descriptions, including
attachment names and sizes. They do not reproduce OneNote's canvas, transcribe
ink or images, edit notebooks, or expose attachment downloads. Check the returned
warnings when sections or content could not be recovered. Project members can
always download the original through Files.

### Submitting files from external systems

Any system that can send HTTPS requests can push files into a project's
Imports. Create a personal API key (user menu → API keys) with **Submit files
to Imports from external systems**; the key's owner must be an Editor of the
target project, and the key may additionally be restricted to that project.
The capability is never granted to browser sessions or OAuth clients.

`POST <AUTH_URL><base path>/api/ingestion/external` accepts one file per
request, either as multipart form data (`projectId`, optional `label`, then one
`file` part) or as JSON with base64 content:

```bash
curl -X POST "$WEAVER_URL/api/ingestion/external" \
  -H "Authorization: Bearer wvr_…" \
  -F "projectId=<project uuid>" -F "label=nightly export" \
  -F "file=@report.pdf;type=application/pdf"

curl -X POST "$WEAVER_URL/api/ingestion/external" \
  -H "Authorization: Bearer wvr_…" -H "Content-Type: application/json" \
  -d "{\"projectId\":\"<project uuid>\",\"fileName\":\"notes.md\",\"contentType\":\"text/markdown\",\"content\":\"$(base64 < notes.md | tr -d '\n')\"}"
```

A `201` response carries `{ batchId, file: { id, fileName, status } }`. The
file is parsed, analyzed, and linked like an upload and waits under **Imports**
as an **External** batch until an Editor reviews it; nothing is accepted
automatically. The same formats and `WEAVER_INGESTION_MAX_FILE_BYTES` limit
apply; the JSON form additionally caps decoded content at the smaller of 10 MiB
and the file cap, so send larger files as multipart. Errors are JSON
`{ error }` with `400` for malformed or interrupted input, `401` (missing,
invalid, or revoked key), `403` (capability or Editor role missing), `404`
(unknown project, not a member, or outside the key's project restriction),
`413`, `415`, `429` (every response sets `Retry-After`; Better Auth's per-key
limit falls back to 60 seconds), or `503`. The per-key, single-instance
in-process window is `WEAVER_INGESTION_EXTERNAL_RATE_LIMIT_PER_MINUTE`
(default 60). A `503` that carries `{ batchId, file }` means the file was
stored but its parse job could not be published: do not resubmit, the scheduled
reconcile republishes it.

### Connecting Claude Code as an administrator

Create a personal API key under **API keys** with **System administration**
enabled, then register the local MCP endpoint without storing the secret in the
repository:

```bash
claude mcp add --transport http weaver http://127.0.0.1:3200/mcp \
  --header "Authorization: Bearer wvr_…"
```

The 34 administration tools are available only while the key owner remains a
global Admin. Prefer a dedicated key and revoke it when the administrative
session is no longer needed.

Example administrative prompts:

- “Enable verbose diagnostics for this debugging session.”
- “Show the latest failed jobs and diagnostic errors.”
- “List the configured models and assign model `<modelId>` to the `assistant` route.”

Knowledge rebuilds, retries, and project reconciliation also require the key's
`content:write` capability (**Edit content directly, without review**) and project
Maintainer membership. Knowledge tools
respect the request's project scope. Credentials supplied to LLM connection
creation or updates are encrypted and never returned in tool results.

### Review hardening deployment settings

Compose pins `NODE_ENV=production` for web, workers, MCP and migrations. Set
`AUTH_URL` to the public HTTPS origin even when TLS terminates at Traefik;
loopback HTTP is permitted for local tests. The supplied Traefik configuration
sends HSTS for one year. `SKIP_ENV_VALIDATION` is a web-build-only escape hatch;
worker/MCP runtime configuration always parses and validates its values.

LLM, Docling and external MCP requests resolve and validate DNS before each
request, pin an approved address, and refuse automatic redirects. Public
HTTPS is the default. For local/private services, explicitly list their exact
origins in `WEAVER_OUTBOUND_ALLOWED_ORIGINS`, for example
`http://ollama:11434,http://docling:5001,https://mcp.internal`. These entries
permit requests and credentials to those origins; use only services trusted by
the deployment operator. Non-production loopback endpoints need no entry. Private-range
hosts (for example `https://litellm.internal`)
resolve outside public unicast and must be listed too; a missing entry now
surfaces as `endpoint not allowed by the outbound policy` in failure messages.
Changing an LLM connection origin requires a replacement credential.

Browser uploads are limited to ten requests per user per minute across web
processes. External uploads share a per-user database limit in addition to the
per-key limiter. `WEAVER_INGESTION_PROJECT_QUOTA_BYTES` defaults to 5 GiB of
retained uploads per project; `WEAVER_INGESTION_MIN_FREE_BYTES` reserves 1 GiB
of free space on the shared data volume. Delete completed batches to reclaim
retained upload storage. The worker exposes `/ready` for a bounded queue/DB
probe; `/health` remains process liveness.

Destructive integration/e2e commands accept only `localhost`, `127.0.0.1`,
`::1`, or the Compose `postgres` hostname in addition to the existing exact
DB/data-directory pair guard. Host provisioning discovers `psql` on PATH;
`WEAVER_PSQL` and `WEAVER_PG_ADMIN_USER` override its executable and admin user.

### Disabling worker roles across a deployment

`WEAVER_WORKER_ROLES` assigns consumers to one worker process.
`WEAVER_ENABLED_WORKER_ROLES` declares the deployment-wide union of enabled
roles and defaults to all six roles. Set the same union on every worker;
each worker refuses startup if its own assignment includes a disabled role.
The split Compose workers share this variable, so an ingestion-only worker
preserves the assistant, task and Git schedules used by the other worker.

To disable a role, stop its consumers, remove it from every affected process's
`WEAVER_WORKER_ROLES` (override the Compose assignment where necessary), set
`WEAVER_ENABLED_WORKER_ROLES` consistently, then restart all workers. Startup
removes assistant/task/Git/wiki cron schedules excluded from the deployment union.
Previously queued jobs stay durable. Re-enable the role in both lists and
restart its assigned worker to register its schedule again.

### Credential and deployment trust boundaries

Deactivation, administrator password reset, and self-service password changes
revoke personal API keys and OAuth grants. Reactivation does not restore them;
create replacement keys or authorize connected apps again. Assistant runs require
the originating live session at lease time, heartbeat, each native tool call and
automatic write admission. External approvals must be decided from that same
browser session; another browser login as the same user cannot approve them.

Global Admin is a trusted account and membership administrator. Content APIs still
require project membership, but an administrator can reset an account's password
or grant another controlled account membership. This is an accepted limit of the
single-administrator recovery model; the diagnostic log records those operations.
Project Owners and Maintainers add registered accounts directly, without an
invitation/acceptance flow. Their membership management can reveal whether an
email belongs to a registered account. Editors may rename and re-describe projects.

Weaver requires an origin shared only with equally trusted applications. A cookie
path and a distinct cookie name avoid collisions; they do not isolate another
application's scripts on the same origin. Use a dedicated hostname to isolate
Weaver from less-trusted applications.

Scheduled-task definitions, saved source scope, external input arguments, error
messages and context summaries are visible only to the task owner. Output-project
Maintainers retain pause, resume, run-now and delete authority under the task
management policy; executions use the owner's current access. Resume a paused
task before Run now. Queued runs encountered while paused are skipped without
counting as failures; a pause does not recall a write already admitted.

Automatic external connections deliberately permit enabled read and write tools
without per-call approval, as stated in the connection dialog. Choose “Ask before
each tool call” when each external side effect requires approval. Assistant and
task prompt budgets intentionally use UTF-8 bytes as a conservative upper bound
on tokens across languages and providers; configured context windows are token
counts, but no optimistic bytes-per-token ratio is assumed. Both model budget
fields must be positive when set.

SSH Git remotes resolve DNS before connecting and pin SSH to a validated address.
Private, loopback, link-local and mixed public/private DNS targets are denied by
default. Set `WEAVER_GIT_ALLOWED_SSH_TARGETS` to a comma-separated list of exact
host:port exceptions, for example `git.internal:22,[::1]:2222`, on the web and Git
worker runtimes before upgrading an installation that uses internal Git hosts.
An exception trusts that host and port for SSH operations; it never opens other
ports. Public destinations need no exception. Connection and authentication
failures share the generic network error; saved host-key mismatches remain
explicit so an operator can investigate them. Every failed push or pull also
writes a `git.remote.push_failed` / `git.remote.pull_failed` error event to the
diagnostics log (Administration › Diagnostics); its `cause` names a denied
target and this setting, or carries the SSH error text.

Demo training accounts: `trainer@weaver.local` (Editor, Trainer) and
`trainee@weaver.local` (Viewer, Trainee), password `admin1234567`. Run `pnpm db:seed`
to add them idempotently to the Demo Project.

### Recovering the released knowledge-identity migration

If `20260926090000_knowledge_index_identity` failed partway through, stop all
web, worker and MCP writers and take a database backup before recovery. Do not
edit its migration file, mark it rolled back, or retry deployment against its
partially created objects. The repair at
`packages/db/prisma/recovery/knowledge-index-identity.sql` completes every
statement idempotently in one transaction, with exclusive locks on the affected
tables. It refuses an already-applied migration or any later applied migration.

Using the affected deployment's database connection (never a different local
or test database), run:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/prisma/recovery/knowledge-index-identity.sql
pnpm --filter @weaver/db exec prisma migrate resolve --applied 20260926090000_knowledge_index_identity --config prisma.config.ts
pnpm --filter @weaver/db run migrate:deploy
```

Run `resolve` only after the repair transaction commits. If repair fails, its
new changes roll back and the same repair can be retried after correcting the
reported cause. If `resolve` alone fails, retry it after verifying the committed
repair. Resume writers only after migration deployment succeeds. The forward
fingerprint correction then applies the verified vector-space identity to all
related rows. Other migration failures require their own recovery procedure.
