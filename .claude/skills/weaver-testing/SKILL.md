---
name: weaver-testing
description: Use when writing or running tests in the Weaver workspace — app/package Vitest tests, apps/web integration or browser specs, worker/package boundaries, cross-process Git locking, or the RUN_FULL_TESTS consent gate.
---

# Weaver Testing: Harness and Suite Conventions

Tests split into colocated app/package Vitest unit tests, sequential DB-backed
integration specs under `apps/web/tests/integration`, root `node:test`
architecture checks, and Playwright under `apps/web/tests/e2e`. CLAUDE.md
Standing Rule #4 decides the authorized tier.

## Key files

| Path                                                                      | Role                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/vitest.config.ts`                                               | Web unit configuration; each shared package/worker also owns a colocated Vitest command                                                                                                                                                                                 |
| `apps/web/vitest.integration.config.ts`                                   | Integration specs, one sequential fork, 30-second timeout, `_setup.ts`                                                                                                                                                                                                  |
| `apps/web/tests/integration/_harness.ts`                                  | Callers/fixtures; `resetDb()` stops the global publisher, then truncates pg-boss, Prisma models, and Git                                                                                                                                                                |
| `apps/web/tests/integration/_setup.ts`                                    | Mocks `~/server/auth`; real Better Auth behaviour comes from `testAuth()` in `_harness.ts`                                                                                                                                                                              |
| `apps/web/tests/integration/_oauth.ts`                                    | Shared OAuth client registration, authorization-code/PKCE, access-token, and DPoP proof helpers                                                                                                                                                                         |
| `apps/web/tests/integration/gitStore.spec.ts`                             | Per-project Git operations, recovery, and immutable committed-reader behavior                                                                                                                                                                                           |
| `apps/web/tests/integration/gitStoreLocking.spec.ts`                      | Real child-process same-project serialization, different-project overlap, and connection-death lock release                                                                                                                                                             |
| `apps/web/tests/integration/securityContext.spec.ts`                      | `SecurityContext` capability/role math and `authenticationMethod` construction for session/apiKey/oauth actors                                                                                                                                                          |
| `apps/web/tests/integration/apiKeys.spec.ts`                              | `apiKey` router: create/list/revoke, capability defaults, project restriction, expiry, rate limit, last-used, one-time secret                                                                                                                                           |
| `apps/web/tests/integration/bearerAuth.spec.ts`                           | OAuth code/refresh rotation and replay, JWKS/discovery, audience binding, and API-key bearer resolution                                                                                                                                                                 |
| `apps/web/tests/integration/mcpOperations.spec.ts`                        | Direct-write idempotency, recovery, authorization, audit, pruning, and cross-process/cross-project serialization                                                                                                                                                        |
| `apps/web/tests/integration/mcpServer.spec.ts`                            | Official MCP client over a loopback server: bearer/OAuth/DPoP, tools/resources, writes/replay, protocol limits, and audit                                                                                                                                               |
| `apps/web/tests/integration/oauthConsents.spec.ts`                        | Session-only consent management, exact-generation revocation/cutover, and OAuth/revoke concurrency                                                                                                                                                                      |
| `apps/web/tests/integration/bootstrapAdmin.spec.ts`                       | `bootstrapAdmin` against the real Prisma adapter: first-Admin creation and the empty-table refusal                                                                                                                                                                      |
| `apps/web/tests/integration/passwordChangeGate.spec.ts`                   | Shared Better Auth forced-password-change gate: prior-consent routing to the consent page, consent-acceptance replay refusal, and the exact route allowlist, each negative behind a positive control                                                                    |
| `apps/web/tests/integration/llm.spec.ts`                                  | LLM CRUD, secret redaction/rotation/startup checks, provider tests, routes, and cache behavior                                                                                                                                                                          |
| `apps/web/tests/integration/documentSummaries.spec.ts`                    | Save-then-queue change comments, worker outcomes (timeout retries, validation, skips), fencing, reconcile, and diagnostics privacy                                                                                                                                      |
| `apps/web/tests/integration/changeSummaryInspection.spec.ts`              | Admin-only change summary inspection: metadata-only output, filters, counts, cursor paging, tRPC and MCP                                                                                                                                                                |
| `apps/web/tests/integration/diagnostics.spec.ts`                          | Diagnostics settings, runtime/job/provider/auth hooks, filtered queries, Unicode-safe body pages, retention, and cross-process pruning                                                                                                                                  |
| `apps/web/tests/integration/ingestionExternal.spec.ts`                    | External feed: origin-aware authorization, API-key-only route, multipart and JSON forms, limits, per-key rate window, publication failure                                                                                                                               |
| `apps/web/tests/integration/assistantConversations.spec.ts`               | Conversation/message CRUD, per-message scope snapshots, capability checks                                                                                                                                                                                               |
| `apps/web/tests/integration/assistantRuns.spec.ts`                        | Submit/lease/event-sequence/cancel/complete/fail/`reconcileAssistantRuns` behavior                                                                                                                                                                                      |
| `apps/web/tests/integration/assistantProposals.spec.ts`                   | Create/accept/reject/conflict/expire, base-revision checks, audit trailers                                                                                                                                                                                              |
| `apps/web/tests/integration/assistantTools.spec.ts`                       | Every registered tool contract: scope enforcement, capability gating, bounded outputs                                                                                                                                                                                   |
| `apps/web/tests/integration/assistantRunner.spec.ts`                      | `@weaver/ai`'s `executeAssistantRun` end-to-end against a mock model or real provider SDK over `createMockAiServer()`, including timeout and abandon paths                                                                                                              |
| `apps/web/tests/integration/assistantRouter.spec.ts`                      | The `assistant` tRPC router and the SSE events route                                                                                                                                                                                                                    |
| `apps/web/tests/integration/scheduledTasks.spec.ts`                       | `scheduledTask` router/service role matrix and limits, run-now/`CONFLICT`, concurrent-tick claiming, the `@weaver/ai` task runner end to end against a mock model, skipped/paused/`ABANDONED` runs — see `weaver-scheduled-tasks`                                       |
| `apps/web/tests/e2e/tasks.spec.ts`                                        | Project › Tasks browser flow: create a task, run it now via the row menu, watch it succeed, and open the output document with its "Maintained by" banner — see `weaver-scheduled-tasks`                                                                                 |
| `apps/web/playwright.config.ts`                                           | Receives the root command's e2e env, starts web plus separate worker/MCP runtimes, and forwards the exact database/data pair                                                                                                                                            |
| `apps/web/tests/e2e/`                                                     | Auth, project, document, table, and knowledge browser workflows plus deterministic AI fixture                                                                                                                                                                           |
| `apps/web/tests/e2e/admin-ai.spec.ts`                                     | Administration › AI connection, model, test, and route workflow                                                                                                                                                                                                         |
| `apps/web/tests/e2e/mcp.spec.ts`                                          | Running mcp-server: API-key direct write plus browser OAuth consent, token use, and immediate revocation                                                                                                                                                                |
| `packages/core/src/runtime/lifecycle.test.ts`                             | Shared signal-handler installation, reverse-order shutdown, timeout, and error behavior                                                                                                                                                                                 |
| `scripts/{workspace-layout,package-boundaries,compose-services}.test.mjs` | Monorepo, dependency direction, job ownership, web/worker/MCP compose checks, and the client-import guard (`pnpm test:scripts`): browser-reachable web files only type-import `@weaver/core/services/*`, `assistant/scope`, `jobs/*`, `@weaver/git-store`, `@weaver/db` |
| `scripts/agent-instruction-paths.test.mjs`                                | Canonical instruction paths, public database API guidance, and Claude/Codex skill symlinks                                                                                                                                                                              |
| `apps/web/tests/e2e/mock-ai-server.mjs`                                   | Deterministic HTTP double for the assistant/knowledge provider used by `pnpm e2e`; persona phrases drive the assistant flow                                                                                                                                             |
| `apps/web/tests/e2e/mock-ai-server.test.mjs`                              | Node `test` coverage of the mock server itself (`pnpm test:mock-ai`) — safe to run freely, alongside `pnpm check`/`pnpm test`                                                                                                                                           |
| `scripts/guard-expensive-tests.mjs`                                       | Tier 3 guard; consent token is `RUN_FULL_TESTS=1`                                                                                                                                                                                                                       |
| `scripts/require-env.mjs`                                                 | Env-pair guard wrapping every `db:*`/`test:integration*`/`e2e` script; tested by `scripts/require-env.test.mjs`                                                                                                                                                         |

## Placement and harness rules

- Unit tests are colocated as `apps/**/src/*.test.ts` or
  `packages/**/src/*.test.ts`; run them with `pnpm test`.
- `apps/web`'s Vitest config runs under `environment: "node"`, without
  jsdom. Static `react-dom/server` tests assert markup; mounted
  `react-test-renderer` harnesses exercise callbacks, effects, React state and
  react-hook-form transitions (including the external connection/task editors).
  They provide no real browser events, focus, layout or navigation proof. Keep
  pure transitions/reducers in colocated unit tests; use the guarded Playwright
  suite for browser behavior.
- Integration specs are
  `apps/web/tests/integration/<name>.spec.ts`; run one or several explicit paths
  through `pnpm test:integration <paths>`. Import Vitest lifecycle functions
  explicitly because globals are disabled.
- Drive tRPC procedures through `callerFor(user)` from `_harness.ts`, never
  HTTP. Build fixtures with `makeUser` (a real Better Auth credential user,
  password `TEST_PASSWORD`), `makeProject` (also creates the backing Better
  Auth organization), `addMembership` (writes a `Member` row), and
  `getPrisma`; use a unique suffix for each spec/describe. Route handlers use
  the `@weaver/db` singleton, a different client: spy on `db` from `@weaver/db`
  (not `getPrisma()`) to inject faults into code reached through a route. `testAuth()`
  returns the shared Better Auth instance and `securityContextFor(user)`
  builds a `SecurityContext` directly when a spec needs one without going
  through `callerFor`.
- For a caller authenticated as an API key or OAuth token rather than a
  session, use `callerWithSecurity(user, securityContext)` to supply an
  explicit `SecurityContext` (e.g. from `createApiKeySecurityContext`/
  `createOAuthSecurityContext`) instead of the session-derived one `callerFor`
  builds; it also wires `ctx.apiKeyIssuer` from `createApiKeyIssuer(testAuth())`.
  `TEST_MCP_RESOURCE` and `TEST_ISSUER` are the fixed audience/issuer strings
  `testAuth()` is configured with; `ensureOAuthResource()` re-seeds the
  `OauthResource` row after `resetDb()` truncates it (the provider only seeds
  it once, at plugin init) before a spec authorizes against it.
- Browser-style Better Auth POSTs issued directly as `fetch`/`Request` calls
  (not through `callerFor`) — OAuth `/consent`, `/authorize` — need an
  explicit `Origin` header matching `testAuth()`'s `baseURL`; Better Auth
  rejects a same-origin state-changing request without one.
- Every integration test starts with `resetDb()` in `beforeEach`. The suite
  shares one process, one `weaver_test` database, and `./data-test`; no spec may
  assume another spec left either PostgreSQL or Git empty.
- `setupFiles` re-run for every spec file even with `isolate: false`, but the
  module registry is shared: a module an earlier spec imported (a route handler
  under `apps/web/src/app/api/**`, say) keeps the function object from the
  first `vi.mock` factory run, so a mock a later spec recreates never reaches
  it. Mocks shared across specs must be process singletons, as `_setup.ts`
  does for `getSessionUser` (`vi.hoisted` stashing one `vi.fn` on
  `globalThis`). The per-spec `vi.mock("~/server/auth/bearer", …)` mocks work
  today only because every spec configures the same issuer and audience.
- `testEncryptionKeys()` supplies the deterministic test-only key ring.
  `CallerOverrides` accepts `llmFetch` and `encryptionKeys`; pass these through
  `callerFor(user, overrides)` to exercise provider behavior or missing-key
  paths without mutating process globals.
- Provider HTTP is allowed only through an injected `fetchImpl` fake. Unit and
  integration tests must never call a real provider or depend on the network.
  Most assistant runner specs inject a deterministic model: build an
  `ai/test` `MockLanguageModelV4` (or a scripted multi-step factory) and pass
  it as `modelFactory` to `createAssistantRunner`/`executeAssistantRun`.
  `assistantRunner.spec.ts` also runs one case through the real provider SDK
  against an in-process `createMockAiServer()`; it still makes no external
  network request.
- `resetDb()` stops the global publisher before resetting pg-boss, Prisma, and
  Git. The pg-boss reset also drops every dedicated partition of `pgboss.job`
  other than `job_common`: truncating `pgboss.queue` alone leaves partitions a
  killed run created attached, and pg-boss then fails every later
  `createQueue`/`send` for that queue name (`knowledgeJobs.spec.ts` covers it). Stop any test-owned real queue/worker before reset so claiming cannot
  race truncation. Prefer `FakeJobQueue`; use `PgBossQueue`
  only when claiming/retry/scheduling/singleton/cleanup is the contract, give it
  isolated names, and always stop it. `FakeJobQueue.run()` frees a singleton
  key when it starts that job, matching pg-boss's created-state uniqueness, so
  a test can immediately re-send the same singleton after running it.
- Git-backed specs use real repositories and assert Git/commit state as well as
  API results. Plant recovery state only below `WEAVER_DATA_DIR`.
  For rollback, inspect physical bytes with `node:fs/promises.readFile` plus Git
  index/status inside the failing writer callback before another writer can recover
  residue. `repo.readFileFromWorktree` reads committed HEAD, not physical files.
  Cover new staged files (including absent-root `.folder.json`) after real staging.
- MCP write-timeout coverage must hold a real project Git lock, observe
  `CANCELLED`, release/drain the lock, and prove no later commit or operation
  row appeared. Crash-recovery fixtures must persist and compare the request
  hash/tool Git trailers, including changed-request failure.
- OAuth cutover lock-order coverage starts revocation with the consent row
  already locked, queues the writer-conflicting migration barrier, and proves
  revocation plus migration both settle. DPoP cleanup coverage keeps live and
  non-DPoP `Verification` rows while deleting only expired replay rows.
- Use `gitStoreLocking.spec.ts` when changing advisory locking or committed
  readers. It spawns independent Node processes against PostgreSQL; keep its
  child timeout/cleanup budget below the suite's fixed 30-second ceiling.

## Browser rules

E2E requires `.env.e2e` paired with `weaver_e2e` + `./data-e2e` and an applied
`pnpm db:e2e:migrate`. Always invoke the root `pnpm e2e` command: its config
starts web, `@weaver/agent-worker`, and `@weaver/mcp-server`, resolves the raw repository-relative
data directory to one absolute path for all runtimes, and never reuses a
server. Never invoke the browser runner directly. Preparation runs before application startup, clears pg-boss and paired Git/upload roots, and creates login users; specs create
feature data through the UI.

- `apps/web/tests/e2e/documents.spec.ts` covers document organization, direct
  editing on desktop/phone, permanent header toolbar/Context layout, editable raw
  Markdown without a source panel, literal-text/rich-content round trips, invalid
  raw drafts, focus/scroll restoration, and saving/discarding in either mode,
  saved-baseline undo/redo, explicit discard,
  Viewer rendering, Mermaid, references, history/diff, and append-only restore.
  Reuse `document-helpers.ts` for direct Save and `expectDocumentToolbar`; there is
  no Edit/Done entry or change-summary dialog. Wait for
  Save to disappear and the same editable canvas to remain after success.
- `apps/web/tests/e2e/tables.spec.ts` is the canonical serial typed-table flow:
  canonical reload, local sort/filter, navigation guard, real two-context
  conflict, structured history/restore, references/backlinks, roles, and narrow
  editing.
- `apps/web/tests/e2e/knowledge-ui.spec.ts` is the canonical serial knowledge
  flow: grouped search/fallback, section focus, graph/provenance/capacity,
  responsive access, shadow rebuild, and failed-work retry.
- `apps/web/tests/e2e/api-keys.spec.ts` covers personal API keys end to end:
  create a key from the user menu, reveal the one-time secret, confirm it
  disappears from the page, and revoke it.
- `apps/web/tests/e2e/mcp.spec.ts` covers an API key driving the running
  mcp-server and a browser OAuth consent whose token the server accepts until
  it is revoked.
- `apps/web/tests/e2e/assistant.spec.ts` is the canonical serial assistant
  panel flow: scope selection from a document page, streaming, citations, a
  proposal accept whose commit and status persist across reload, mid-run
  reload reconnecting to the still-unfinished run, cancel reaching the
  terminal `cancelled` state, the full-page `/assistant` route showing the
  same conversation, a Viewer getting no proposal, and cross-user conversation
  isolation. It drives the deterministic mock AI server
  (`apps/web/tests/e2e/mock-ai-server.mjs`) through persona phrases in the
  user message: "slow" streams a delayed plain answer; "cite" or "propose"
  (only once the persona has read the scoped document) answers in prose or
  calls `propose_document_edit`; anything else gets a plain answer with no
  sources.
- The Tier 3 scheduled-tasks browser flow (`weaver-scheduled-tasks`) drives
  the mock AI server's task branch, seeded through the e2e `jobs` route:
  create a task from the UI, run it now, watch it succeed, open the output
  document and its banner, and see the run in the history.

Use accessible roles/names and visible readiness transitions, not CSS selectors,
arbitrary sleeps, direct knowledge fixtures, or toast-only assertions.

The e2e runtimes run with `NODE_ENV=production`, where the outbound policy no
longer allows loopback implicitly; `playwright.config.ts` therefore passes
`WEAVER_OUTBOUND_ALLOWED_ORIGINS` naming the mock AI and mock MCP fixture
origins. A new loopback fixture must be added to that list or every AI,
task, and external-MCP flow fails with `OUTBOUND_NOT_ALLOWED` (visible in the
`weaver_e2e` `DiagnosticEvent` table after a run).

## Tier cadence

| Change                                       | Minimum verification                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/web/src/server/api/routers/<area>.ts`  | `apps/web/tests/integration/<area>.spec.ts`                             |
| `packages/core/src/services/<name>.ts`       | affected `apps/web/tests/integration/<name(s)>.spec.ts`                 |
| app/package pure utility                     | colocated unit via `pnpm test`                                          |
| Prisma schema/migration/shared runtime       | affected Tier 2 area set                                                |
| Tables foundation                            | `pnpm test:integration:tables`                                          |
| Ingestion                                    | `pnpm test:integration:ingestion`                                       |
| Documents foundation                         | `pnpm test:integration:documents`                                       |
| Knowledge foundation                         | `pnpm test:integration:knowledge`                                       |
| Assistant backend                            | `pnpm test:integration:assistant`                                       |
| MCP runtime                                  | `pnpm test:integration:mcp`                                             |
| UI only                                      | `pnpm check`; browser coverage is Tier 3                                |
| Import added/moved across a package boundary | root `pnpm test` — filtered suites skip `test:scripts`'s boundary guard |

Bare `pnpm test:integration` and every `pnpm e2e` invocation are Tier 3. Ask
for fresh user consent, verify the exact environment pair, and then prefix with
`RUN_FULL_TESTS=1`. Run long commands once and inspect the captured output
instead of rerunning to filter it. The hook parses executable commands and
requires an effective `RUN_FULL_TESTS=1` assignment; comments, quoted prose,
and zero values do not grant consent. Read-only config inspection is cheap.
This is a workflow gate, not proof that human consent was obtained.

## Adding an integration spec

1. Create `apps/web/tests/integration/<entity>.spec.ts` and import the lifecycle
   hooks plus harness helpers explicitly.
2. Call `resetDb()` in `beforeEach`.
3. Build explicit users, projects, and memberships with unique fixture suffixes.
4. Exercise the router through `callerFor(user)` and assert the exact public
   error contract.
5. Cover allowed project roles, disallowed visible roles, global Admin, and a
   non-member. Invisible resources are `NOT_FOUND`, not `FORBIDDEN`.
6. Verify with
   `pnpm test:integration apps/web/tests/integration/<entity>.spec.ts`.

## Safety checks

- Before any integration command, require `.env.test`, print only its database
  pathname and data directory, and accept exactly `/weaver_test ./data-test`.
- Before any browser command, require `.env.e2e`, accept exactly
  `/weaver_e2e ./data-e2e`, migrate it, and ensure no development server can be
  reused on the test port.
- The root `db:*`/`test:integration*`/`e2e` scripts run through
  `scripts/require-env.mjs`: a missing env file, a file naming another
  database/data-dir pair, or a shell `DATABASE_URL`/`WEAVER_DATA_DIR` that
  differs from the file aborts the command. Fix the file or unset the shell
  variable; never call `dotenv`/`vitest`/`playwright` directly to get around
  it — a wrong pair can truncate development rows and delete dev Git.
- Do not change the 30-second integration timeout to hide a slow test; split or
  bound the work.

- `apps/web/tests/integration/ingestion.spec.ts` covers uploads, claims, drafts,
  bounded batch lists, recovery, and accept/reject. It drives all three stage
  runners against `FakeJobQueue`, uses `advanceToReady` for review fixtures, and
  reads commits through `withProjectRepo(...).logForPath(".", { operationId })`.
  `pnpm test:integration:ingestion` runs it with `ingestionExternal.spec.ts`.
  The Tier 3 `apps/web/tests/e2e/imports.spec.ts` exercises upload, review, and
  acceptance without an ingestion route; `apps/web/tests/e2e/imports-external.spec.ts`
  pushes a file with a key created in the UI. `apps/web/tests/integration/adminInsight.spec.ts`
  covers admin operational services.
- `packages/ingestion/src/*.test.ts` are colocated Vitest unit tests for the native adapters, the Docling adapter, adapter selection/fallback, and the OCR client; run with `pnpm test`. Byte fixtures (DOCX/PDF/PNG/XLSX) are generated at test time by `@weaver/ingestion/fixtures` — never check in binary sample files. Every OCR/model call in these tests and in `ingestion.spec.ts` goes through an injected `modelFactory` (an `ai/test` `MockLanguageModelV4`, matching the assistant-runner convention above) and every Docling HTTP call through an injected `fetchImpl`; no ingestion test reaches a real provider or a real docling-serve endpoint.
- The integration config pins `NODE_ENV=test`; individual specs must not depend on environment stubs leaked from earlier specs. `apps/web/tests/_reset.ts` shares destructive reset logic; its in-process exact-pair guard also protects direct runner invocations. All area suites sharing a database must run sequentially.
- `pnpm test` includes `pnpm test:scripts` before package unit suites. Browser authoring and assistant fixture behavior are described by `weaver-assistant`; consent tiers remain in CLAUDE.md.

## Background-work verification

`apps/web/tests/integration/backgroundWork.spec.ts` covers source normalization,
access-before-pagination/counts, private assistant scope checks, cursor binding,
exact revision receipts and bounded retention. Schema/cursor/runtime and web
presentation helpers have colocated unit coverage. The shell unit harness mocks
BackgroundWorkProvider when testing unrelated shell layout. Browser behavior lives
in `apps/web/tests/e2e/background-work.spec.ts` and remains subject to Tier 3 consent.

## Dashboard verification

`dashboard.spec.ts` covers bounded recent/activity/snapshot/report reads, audience
and scope privacy, signed cursor/filter binding, report deduplication and live
membership checks. `projectPins.spec.ts` covers storage independence, actual table
projection rebuild, literal title candidates, serialized capacity, duplicate
idempotency and router authorization. Dashboard helpers and static component
semantics have Node Vitest coverage. `apps/web/tests/e2e/dashboard.spec.ts` covers Home,
overview navigation, pins, assistant scope/privacy, result receipts and retry;
authored browser tests still require the Tier 3 consent gate before execution.

## External MCP acceptance fixtures

`apps/web/tests/e2e/mock-mcp-server.mjs` binds loopback port 4011 (override only
`WEAVER_E2E_EXTERNAL_MCP_PORT`) and exposes generic `read_counter`/`set_counter`.
Playwright starts/closes it with `reuseExistingServer: false`; tests use its
synthetic control route for reset and one dropped write response. It never reads
production connection configuration or credentials. `scripts/mock-mcp-server.test.mjs`
runs in the root Node suite. Deterministic AI personas choose only explicitly
supplied external schemas and handle each user turn independently.

`external-mcp.spec.ts` covers Account discovery/review (signed in as the Global
Admin, whose connections may use the e2e `WEAVER_OUTBOUND_ALLOWED_ORIGINS` to reach
the loopback fixture), approval/denial/reload, Never-ask writes, policy
invalidation, unknown outcomes, and task provenance/failure preserving prior
report history. Assert fixture call
counts and counter side effects, not only UI success text. The prescribed Phase 7A
browser area also includes assistant, tasks and background-work specs; every browser
run still requires current Tier 3 consent and the guarded root command.

To run alongside development servers, set `PLAYWRIGHT_BASE_URL` (web),
`WEAVER_E2E_WORKER_PORT` (default `3101`), and `WEAVER_E2E_MCP_PORT` (default
`3200`) to free local ports. Playwright keeps readiness URLs, child listeners and
MCP resource URLs aligned; it still refuses server reuse and retains the guarded
`weaver_e2e` / `./data-e2e` pair.

`makeUser` now creates a persisted session with ID equal to the user's fixture ID;
`securityContextFor` and the default caller use that session. Assistant leases and
automatic writes revalidate sessions, so a fabricated unpersisted credential is
not a valid assistant fixture. Tests exercising real password-change HTTP still
sign in and forward cookies as before.

## Content appearance verification

`contentAppearance.spec.ts` covers Editor/Viewer and nonmember access, item and
folder revision guards, metadata timestamps, image+metadata commits, rollback
before/after staging, validated committed icon reads/ETags, multipart body caps,
reserved-root discovery, current appearance during table merge/content restore,
and document/table projection rebuild and deleted-content recovery. Git-store
unit tests cover safe untracked-file rollback and refusal of tracked, traversal
and symlink targets. Run it with the affected `documentMetadata`, `folders`,
`tables`, `tableFolders` and `documentReview` specs under Tier 1/2, sequentially
against guarded `weaver_test`.

The shared appearance/explorer Node harnesses cover dirty-field patches,
independent resets, failed multipart upload, fetched-revision refresh, pending
close guards, field-pinned errors, base-path URLs, broken image fallback,
Standard/Compact keyboard and drag/context callbacks, permission demotion, and
blocked storage with deferred preference restoration. Run the Task 3 area with
the web Vitest runner (`pnpm --filter @weaver/web exec vitest run`), selecting
`apps/web/src/components/appearance/`, `apps/web/src/components/explorer/`,
`apps/web/src/lib/explorer/entries.test.ts`, and the affected document/table menu
and adapter tests. Runner selectors are relative to its web-package root. These harnesses verify
React state/callbacks and initial SSR defaults; they do not prove real browser
hydration, focus, CSS contrast or layout. Browser runs retain Tier 3 consent.

Appearance portability is covered by `documentArchiveImport`, `documentDownload`,
`transferApi` and `remoteSend` integration specs: empty styled folder round trips,
shared referenced icon closure, plain-import warnings, preserved Replace metadata,
tampered digests, receiver capability preflight, and staged/unstaged rollback.
Folder staging shares the normal create owner; include `folders.spec.ts` when
changing it. Run those explicit specs sequentially under the guarded integration
command; remote fixtures use injected fetch only. ZIP parser/read/upload helpers
and archive selection/streaming have colocated unit tests.

## Folder reviewer UI verification

`FolderReviewDialog.test.tsx`, `FolderMutations.test.tsx`, the explorer screen and
adapter tests, and `review-cache-invalidation.test.ts` cover configured versus
effective defaults, own/root/project inheritance, unresolved removal, cancelled
obsolete preflights, explicit HEAD writes, size/loading/conflict gates, live
permission demotion, pending close guards, refresh failures and root-only actions.
Run those through the web Vitest runner; real browser focus/layout coverage stays
Tier 3. A real QueryObserver test proves failed active detail refetches propagate
through recursive invalidation. Dirty editors keep their baseline when metadata
reads refresh.

Reviewer preview freshness regressions use the production `createQueryClient`
defaults and real QueryObserver-backed reads, including A → B → A within the
30-second cache window. Accepted-write recovery tests cover assignment and clear,
failed/repeated/pending canonical invalidation and attempted second writes after
concurrent defaults change; no refresh action may replay a mutation.

## File-reader integration coverage

The text/CSV/YAML/structure slice uses explicit `artifactTools`, `assistantTools`,
`mcpOperations` and `mcpServer` Tier 2 specs. Artifact coverage reconstructs long
Unicode ranges, checks original-start versus resumed-row cursors, wide addresses
and columns, oversized rows, late searches, stale replacements and authorization.
Run the focused native-fit/external-overflow case in `assistantExternalTools`
after registry changes; its capacity is derived from actual tool schemas.
Child process tests cover serialized text clipping at CRLF boundaries. Package
boundary checks prohibit pure-reader runtime imports from shared tools or web.

Markdown reader regressions cover container fences/headings, HTML/setext boundaries,
physical CRLF/CR source maps, repeated titles and deep containers. A focused
`artifactTools` case follows overview ids into exact original container sections.
`artifactReads.test.ts` exercises the public gateway with the existing `runReader`
seam: an initially live signal aborted just before a successful runner return must
reject without content, alongside an un-aborted success control.

Project API publishing regressions inject failure immediately after a real Git
commit, then verify retry repairs document/table projections, requeues indexing,
and preserves subsequent updates/deletions without another commit. Publishing
example tests execute generated curl/Python scripts against a local HTTP fixture,
lose the first response, change the input file, and retry in a fresh process with
the same operation ID to verify the original payload and ETag are retained.

## Exams

Exam coverage: `exams.spec.ts`, `examAttempts.spec.ts`, `examTools.spec.ts`, plus membership, background-work and assistant/MCP specs. Run sequentially against guarded weaver_test. Browser `exams.spec.ts` retains Tier 3 consent.
