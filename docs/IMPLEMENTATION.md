# Weaver — Implementation

Living architecture and navigation aid. Update this file with changes that add,
rename, or restructure routers, services, schemas, migrations, runtimes, or UI
areas (CLAUDE.md Standing Rule #1). Link canonical files instead of duplicating
their implementation.

## Agent maintenance skills

Project skills are canonical under `.claude/skills/`; matching relative symlinks
under `.codex/skills/` expose the same instructions to Codex. `AGENTS.md` links to
`CLAUDE.md`, whose Standing Rule #6 contains the complete area catalog.

Focused guides for cross-cutting domains are
[`weaver-projects`](../.claude/skills/weaver-projects/SKILL.md),
[`weaver-project-api`](../.claude/skills/weaver-project-api/SKILL.md),
[`weaver-git-store`](../.claude/skills/weaver-git-store/SKILL.md),
[`weaver-dashboard`](../.claude/skills/weaver-dashboard/SKILL.md), and
[`weaver-remote-instances`](../.claude/skills/weaver-remote-instances/SKILL.md).
The existing document/table, assistant, admin and UI guides retain their detailed
editor, review, LLM, external-MCP and explorer conventions. Path and discovery
invariants are checked by `scripts/agent-instruction-paths.test.mjs`.

## Runtime composition

Weaver is a pnpm 12.14.0/Turborepo workspace. Root scripts in
[`package.json`](../package.json), workspace discovery in
[`pnpm-workspace.yaml`](../pnpm-workspace.yaml), and the task graph in
[`turbo.json`](../turbo.json) are the public developer interface.

| Runtime                | Ownership                                                                                                                                                                                                                                                                                                                                                                                                       | Canonical entry points                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@weaver/web`          | Next.js 16/React 19 UI, Better Auth, tRPC adapters, health route, and durable job publishing                                                                                                                                                                                                                                                                                                                    | [`apps/web/package.json`](../apps/web/package.json), [`apps/web/src/`](../apps/web/src/), [`apps/web/next.config.ts`](../apps/web/next.config.ts)                                                                                                                                                                                                                                                                                                                                         |
| `@weaver/agent-worker` | pg-boss consumers, knowledge reconciliation/enrichment, lifecycle, graceful shutdown, private health server, and role-selected consumers (`WEAVER_WORKER_ROLES`)                                                                                                                                                                                                                                                | [`apps/agent-worker/src/index.ts`](../apps/agent-worker/src/index.ts), [`lifecycle.ts`](../packages/core/src/runtime/lifecycle.ts), [`health.ts`](../apps/agent-worker/src/health.ts)                                                                                                                                                                                                                                                                                                     |
| `@weaver/external-mcp` | Bounded outbound MCP SDK 2.0 transport: HTTP JSON/SSE legacy negotiation, per-request credentials, local JSON Schema validation, atomic catalog limits, canonical endpoint reporting for private admin configuration (2048-character URLs), and no automatic call replay. Unsupported schemas remain discoverable with a closed unavailable status. Synthetic loopback fixture is exported only at `./testing`. | [`client.ts`](../packages/external-mcp/src/client.ts), [`http.ts`](../packages/external-mcp/src/http.ts), [`schemas.ts`](../packages/external-mcp/src/schemas.ts), [`types.ts`](../packages/external-mcp/src/types.ts)                                                                                                                                                                                                                                                                    |
| `@weaver/ingestion`    | `DocumentParser` port, native and Docling adapters, OCR over the `ingestion` route, parse/analyze/link runners, and post-commit stage publication; worker-only, `core ← ai ← ingestion ← agent-worker`; an `apps/web` devDependency for integration specs only                                                                                                                                                  | [`packages/ingestion/src/parser.ts`](../packages/ingestion/src/parser.ts), [`native/index.ts`](../packages/ingestion/src/native/index.ts), [`docling.ts`](../packages/ingestion/src/docling.ts), [`ocr.ts`](../packages/ingestion/src/ocr.ts), [`parseStage.ts`](../packages/ingestion/src/parseStage.ts), [`analyzeStage.ts`](../packages/ingestion/src/analyzeStage.ts), [`linkStage.ts`](../packages/ingestion/src/linkStage.ts), [`publish.ts`](../packages/ingestion/src/publish.ts) |
| `@weaver/mcp-server`   | Stateless MCP 2026-07-28 Streamable HTTP runtime: composition only (env, Better Auth instance for key/JWKS verification, listen, lifecycle); the endpoint at the resource URL's path, `/health`, and the RFC 9728 document                                                                                                                                                                                      | [`apps/mcp-server/src/index.ts`](../apps/mcp-server/src/index.ts)                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `@weaver/auth`         | Better Auth instance factory (Prisma adapter; admin, organization, jwt, api-key, MCP OAuth 2.1 provider, and CIMD plugins; disabled bypass routes), the transactional seed/bootstrap credential-user helper, `bootstrapAdmin`, the `ApiKeyIssuer`, and `BearerVerifiers`                                                                                                                                        | [`packages/auth/`](../packages/auth/)                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

The web instrumentation hook starts only the queue publisher; it never
registers consumers. The agent worker exclusively calls
`startKnowledgeWorkers` and `stopKnowledgeWorkers`. See
[`apps/web/src/instrumentation.ts`](../apps/web/src/instrumentation.ts) and
[`packages/core/src/jobs/runtime.ts`](../packages/core/src/jobs/runtime.ts).

The MCP runtime is `apps/mcp-server` over [`packages/mcp`](../packages/mcp/)
(spec §16, §26). Every POST is authenticated by
[`packages/mcp/src/gate.ts`](../packages/mcp/src/gate.ts) through
`resolveMcpPrincipal` (`packages/core/src/security/bearer.ts`): personal
`wvr_` keys, or OAuth access tokens verified against the shared JWKS with DPoP
binding enforced when the token carries `cnf.jkt`, a consent-row check, and
the `mcp:use` capability. A fresh `McpServer` is built per request
([`server.ts`](../packages/mcp/src/server.ts)) registering only the
`@weaver/assistant-tools` contracts the credential may use plus three
`weaver://` resource templates; the SDK sees an `AuthInfo` with an empty
token. See [MCP runtime](#mcp-runtime).

## Shared packages

Applications may import `@weaver/*`; shared packages never import an
application, Next.js, React, tRPC, `server-only`, or the web `~/*` alias.
[`scripts/package-boundaries.test.mjs`](../scripts/package-boundaries.test.mjs)
specifically rejects application paths, `@trpc/server`, `server-only`, and the
web alias inside shared-package source, and verifies that service
implementations no longer live under the web app. Package manifests plus
workspace lint/typecheck enforce the remaining dependency shape.

| Package                                                     | Responsibility                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@weaver/config`](../packages/config/)                     | Shared server environment parser, including database, jobs/AI, and Git-lock settings                                                                                                                                                                                                       |
| [`@weaver/db`](../packages/db/)                             | Prisma schema, hand-authored migrations, generated client, seed, and singleton/factory                                                                                                                                                                                                     |
| [`@weaver/core`](../packages/core/)                         | Transport-independent services, authorization, documents/tables/knowledge domain code, AI provider boundary, queue publisher, and worker runtime                                                                                                                                           |
| [`@weaver/git-store`](../packages/git-store/)               | Per-project repositories, committed readers, mutation recovery, Git attribution, and PostgreSQL advisory locks                                                                                                                                                                             |
| [`@weaver/mcp`](../packages/mcp/)                           | MCP bearer gate, contract-to-SDK tool and resource adapters, per-request server factory, rate limiter, fetch-shaped HTTP pipeline, node adapter                                                                                                                                            |
| [`@weaver/artifact-readers`](../packages/artifact-readers/) | Pure leaf package (no `@weaver/*`/Node fs/process/network imports) of read-only Word/Excel/PDF/JSON/text/Markdown/CSV/YAML artifact readers and the shared ZIP/OOXML archive guard; see [Artifacts (Files)](#artifacts-files) and the `weaver-artifacts` skill's "Readers package" section |

Core services throw transport-neutral
[`CoreError`](../packages/core/src/errors.ts). The web adapter in
[`apps/web/src/server/api/coreError.ts`](../apps/web/src/server/api/coreError.ts)
maps it to the existing tRPC error contract. Prisma imports go through
`@weaver/db`; generated sources live under
[`packages/db/generated/prisma/`](../packages/db/generated/prisma/).

## Git truth and cross-process consistency

Commit success survives trust-ledger I/O failures; `gitStore.ts` keeps a pending
ledger for reconciliation on the next write. Create recovery in
`services/contentOperations.ts` selects the canonical changed document by its
operation-derived ID. Table historical reads require pinned-HEAD ancestry.

Documents and tables are Git truth under
`${WEAVER_DATA_DIR}/git/<projectId>`; PostgreSQL rows are permission and
rebuildable projection state.

- Every mutation enters
  [`withProjectRepo`](../packages/git-store/src/gitStore.ts) or
  `withExistingProjectRepo` and holds a project-scoped PostgreSQL advisory lock
  for recovery, working-tree changes, and commit.
- Worktree writers and reads in `gitStore.ts` refuse any path with a symlinked
  component (`WorktreePathError`), and pulls reject remote trees carrying
  symlink or gitlink entries, so Git-supplied content cannot redirect a write
  outside the repository.
- [`gitVersion.ts`](../packages/git-store/src/gitVersion.ts)
  (`@weaver/git-store/version`) checks `git --version` against the 2.36
  minimum; the `(workspace)` layout passes the result to `AppShell`, whose
  `GitRuntimeBanner` warns when Git is missing or too old. Only a passing
  result is cached, so an upgrade clears the warning without a restart.
- [`advisoryLock.ts`](../packages/git-store/src/advisoryLock.ts) derives a
  stable signed 64-bit key from the project UUID, blocks server-side with a
  `lock_timeout` deadline (writers take the exclusive lock through a
  per-project in-process turn queue; committed readers take the shared lock
  through a per-project admission chain, so only one reader per project holds
  a pool client while waiting and readers overlap once admitted),
  aborts Git commands when the checked-out session fails, rechecks the connection
  before commit/ref publication, releases in `finally`, and discards failed connections. Lock pooling and
  timing come from `WEAVER_GIT_LOCK_POOL_MAX` and
  `WEAVER_GIT_LOCK_TIMEOUT_MS`.
- Ordinary reads use `openProjectRepo` and immutable Git objects without a
  lock. Each multi-file workflow captures one commit SHA and reads all blobs at
  that revision, so a response cannot mix commits. Operations that inspect the
  mutable working tree use a locked reader/writer entry point. Table history, diff
  and backlinks hold the shared lock; history candidate scans are capped at 2,000.
- Accepted commits can carry a validated `Weaver-Operation-Id` trailer for
  recovery/idempotency work. Trailer parsing trusts only the terminal Git
  trailer block. History uses NUL framing, and user attribution accepts only SHAs
  recorded locally in `.git/weaver-trusted-commits`, never remote identity claims.
- Every repository root carries `project.json`
  ([`projectMetadata.ts`](../packages/core/src/services/projectMetadata.ts)):
  project id, name, description, creation time, members with names, email
  addresses, and roles (including historical values after removal), the
  document review defaults (`documentReview`) and reviewer groups
  (`reviewerGroups`), regenerated from database truth read inside the repository lock. `createProject` initializes the repository
  and commits the file inside the creation transaction (a Git failure rolls the
  rows back); project settings and membership writes re-sync it best-effort
  after their database commit. Document, folder, and table code ignores this
  root file. Creation uses an explicit lock-aware transaction budget and removes a
  fresh repository only after a confirmed database rollback. Membership mutations
  serialize on the project row; Maintainers cannot change peer Maintainers.
- Document images live beside their document as `<folder>/<slug>.assets/<file>`
  ([`documents/images.ts`](../packages/core/src/documents/images.ts),
  [`services/documentImages.ts`](../packages/core/src/services/documentImages.ts)).
  Uploads commit once with an `asset:` message and never touch the `.md`;
  rename moves the directory and rewrites the document's own `<slug>.assets/`
  links in the same commit, move carries it, delete removes it, and restore
  rewrites the historic prefix. Folder listings, rebuild, and slug allocation
  treat `*.assets` directories as reserved. Authorized image reads compare ETags
  before buffering blobs and serve Unicode names with RFC 5987 headers. Markdown keeps plain relative
  `![alt](<slug>.assets/<file>)` links so clones render in any editor.
- Repository recovery repairs an interrupted first commit and skips immutable loose
  object directories, refuses fresh Git lock files, disables remote attribute filters,
  force-stages ignored files, and removes ignored leftovers. Git readers provide batched history/path/blob helpers; document
  history rejects non-ancestor revisions, and table trees use database projections.
  Table deletion carries an expected revision, like other content writes. Document
  restore/diff verifies historical identity; history offsets are capped at 1,000.
  Post-commit document projection failures enqueue a distinct `project.reconcile`
  repair delivery carrying document ids.

Document rebuilds in [`documents.ts`](../packages/core/src/services/documents.ts)
use an ownership-scoped upsert/diff, preserving unchanged chunk projections and
invalidating keyword readiness for restored rows. The shared
[`documents/title.ts`](../packages/core/src/documents/title.ts) schema enforces
the same single-line title invariant in API, MCP, core writes, and rebuilds.

Unit coverage lives beside `@weaver/git-store`. The real multi-process
serialization, different-project overlap, and process-death release contract is
[`apps/web/tests/integration/gitStoreLocking.spec.ts`](../apps/web/tests/integration/gitStoreLocking.spec.ts).

## Project Git remotes

Project Owners configure one SSH remote and destination branch under Project ›
Settings. The session-only [`projectGitRemote` router](../apps/web/src/server/api/routers/projectGitRemote.ts)
uses [`projectGitRemote.ts`](../packages/core/src/services/projectGitRemote.ts)
for membership-serialized configuration and encrypted key upload, replacement,
deletion and safe metadata reads. [`GitRemoteCard.tsx`](<../apps/web/src/app/(workspace)/projects/[projectId]/settings/_components/GitRemoteCard.tsx>)
shows the key name/fingerprint, last pushed commit, failures and next retry.
`ProjectGitRemote` ([migration](../packages/db/prisma/migrations/20260921000800_project_git_remote/migration.sql),
[pull columns migration](../packages/db/prisma/migrations/20260922000800_project_git_remote_pull/migration.sql))
holds configuration, encrypted credentials, first-use SSH host trust, revisions,
queue tickets and attempt leases, plus `pullQueueToken`, `pullRequestedAt`,
`pullRequestedById`, `lastPullSha`, `lastPullAt` and `lastPullErrorCode` for
pulling. Private keys have no read/download API and use the existing versioned
encryption ring with remote-id-bound AAD; all three runtime startup checks and
`pnpm secrets:rotate` include them.

`notifyProjectContentChanged(db, projectId)` (best-effort, never throws) is
called after every content-changing commit — documents, tables, folders,
images, `project.json` syncs, assistant proposal acceptance, ingestion draft
acceptance, MCP content operations and scheduled-task report writes — and
`dispatchProjectGitRemote` runs directly after a remote is saved/enabled,
after a key upload, and after a manual "Push now". Both dispatch a due,
unqueued row immediately instead of waiting for the once-a-minute discovery
pass; a disabled jobs runtime is a no-op and the minute tick remains the
fallback for anything a dispatch call misses.

[`projectGitRemoteJobs.ts`](../packages/core/src/services/projectGitRemoteJobs.ts)
owns `project.git-sync` (minute discovery), `project.git-push` and
`project.git-pull` under the `git` worker role. Database claims and result
fences prevent duplicate deliveries and stale configuration results. Network
attempts have a 60-second abort inside a 180-second lease; expired
tickets/leases recover automatically. Push failures retry at 1, 5, 15, then
60-minute intervals indefinitely while enabled. Configuration changes
invalidate queued work while an admitted push may finish; key deletion pauses
future pushes, and removal waits for an active attempt to finish. Push and
pull share one `leaseToken`/`leaseExpiresAt` pair per row, so at most one of
either is in flight per project at a time; a follow-up push after a pull is
dispatched only once the pull's own lease release has completed, to avoid a
self-deadlock against that still-held lease.

[`@weaver/git-store/remote`](../packages/git-store/src/remote.ts) captures an
immutable HEAD under the shared repository lock, releases it before networking,
and pushes only that SHA to the configured branch without forcing or pulling.
Unchanged HEAD skips network; newer commits wait for a subsequent check. Existing
history includes documents, tables, folders and the already tracked `project.json`;
there is no additional database export. The isolated temporary bare repository
borrows local Git objects, avoiding project/global configuration and hooks.
OpenSSH uses a temporary 0600 key, isolated identity/configuration, first-use host
pinning and subsequent strict host verification. Bounded child process groups are
stopped before temporary files are removed. Keys are deleted as soon as network
commands finish; worker startup sweeps owned temporary directories older than a day.
Core and worker acceptance lives in
[`projectGitRemote.spec.ts`](../apps/web/tests/integration/projectGitRemote.spec.ts)
and [`projectGitRemoteJobs.spec.ts`](../apps/web/tests/integration/projectGitRemoteJobs.spec.ts);
transport coverage includes temporary local bare repositories and generated keys.

Project Owners can also pull the remote branch's existing content into the
project through the "Pull existing content" button on the Git remote card,
which queues `project.git-pull` (payload `{ projectId, pullToken }`,
`retryLimit: 0`, re-runnable, Owner-only, independent of the automatic-push
toggle). `fetchRemoteBranch` fetches the branch into a temporary bare
repository outside the project lock; the merge itself
([`projectGitRemoteMerge.ts`](../packages/core/src/services/projectGitRemoteMerge.ts),
`mergeFetchedBranch`) runs inside `withExistingProjectRepo`, fetching that
bare repository locally into the transient `refs/weaver/pull` ref (always
deleted, including on failure). Fast-forward pulls adopt remote edits, deletions,
renames and replacements. Diverged histories compare content against `merge-base`:
remote-only changes are adopted and local-only changes survive. Conflicting changes
to the same document/table retain the remote original and move the local copy to a
free slug with a fresh identity, including its assets or whole table directory.
Different-identity path collisions also preserve a separate local copy. The local
prepare commit keeps moved content discoverable in ordinary history; the final merge
has remote and prepared local parents and regenerates `project.json` from database
truth. Noncanonical or non-Weaver files are not re-slugged. An already-merged branch
is a no-op unless project metadata needs refreshing.

The pull job rebuilds document and table projections, enqueues project reconciliation,
and clears `lastPushedSha` when HEAD changes. Immediate follow-up push dispatch is
limited to fast-forwards and no-ops, after releasing the pull lease; divergent pulls
disable automatic pushes and advance the configuration revision. An Owner must
reload the saved settings, review the result, and explicitly re-enable pushes;
stale settings cannot silently remove this review pause. The settings advisory lock
serializes merge/outcome recording with configuration saves; index rebuilds run
after release. If PostgreSQL rolls back after Git commits, the worker records the
committed SHA, pauses pushes, and continues repair.

## Database and data model

Dependent forward migrations use explicit transactions. The supported partial
identity-migration repair is
[`knowledge-index-identity.sql`](../packages/db/prisma/recovery/knowledge-index-identity.sql);
[setup recovery instructions](setup.md#recovering-the-released-knowledge-identity-migration)
explain its guards and Prisma resolution. The October 25 migrations correct verified
fingerprints and add project/exam attempt cursor indexes without editing history.

The source of truth is
[`packages/db/prisma/schema.prisma`](../packages/db/prisma/schema.prisma);
[`packages/db/prisma.config.ts`](../packages/db/prisma.config.ts) supplies the
CLI URL. Prisma 7 uses `@prisma/adapter-pg`; the datasource block has no `url`.
Migrations under [`packages/db/prisma/migrations/`](../packages/db/prisma/migrations/)
are hand-authored SQL. `DateTime` columns are `timestamp(3)` without time zone
holding UTC wall-clock: Prisma writes UTC, and raw SQL writes
[`UTC_NOW`](../packages/core/src/services/sql.ts) (never the session-zoned
`CURRENT_TIMESTAMP`/`now()`), setting `createdAt` explicitly instead of relying
on the column default.

Global roles are `Admin | User`; project roles are
`Owner | Maintainer | Editor | Viewer`. `Project.deletedAt` is the soft-delete
boundary. `Project.personalOwnerId` marks a user's undeletable personal
workspace (migration `20260922000700`); see
[`personalWorkspace.ts`](../packages/core/src/services/personalWorkspace.ts).
`ProjectContentPin` stores shared project-scoped document/table UUIDs;
project deletion cascades pins and creator deletion preserves them with a null
creator. Pins deliberately have no projection foreign key or copied content.
`Document` and `DataTable` are Git projections; `DocumentLink` is the
derived typed cross-reference projection. `DocumentChangeSummary` stores AI
change comments per project commit; it is not rebuildable from Git. Knowledge generations, search
chunks, table search metadata, embeddings, graph entities/relations and their
temporal evidence, readiness state, and `AiUsage` remain rebuildable
project-scoped PostgreSQL projections. Tables contribute title and column
metadata to search, never row content, embeddings, or graph facts. Better
Auth's `Jwks`, `ApiKey`, and `Oauth*` tables plus Weaver's `ApiKeyProject`
restriction table were added in 4B-2. Its project FK uses `Restrict` so a hard
project purge cannot widen a restricted key ([migration](../packages/db/prisma/migrations/20260922220100_restrict_api_key_project_deletion/migration.sql)).

Phase 4C added `LlmConnection` (AES-256-GCM credential columns, AAD-bound to
the row id), `LlmModel` (declared capabilities, dimensions, context and max
output limits, prices), and `LlmRoute` (one row per purpose; `Restrict` on
the model FK). `LlmModel.embeddingDimensionMode` is `native` by default; an
Admin explicitly opts an embedding model into `matryoshka` when its configured
dimensions are a safe reduced output size. `LlmRoute.reasoningMode`
(`provider_default` by default, else `none`/`low`/`medium`/`high`) travels on
the route snapshot as the `reasoning` call option: OpenAI-style adapters send
`reasoning_effort`, the Anthropic adapter sends a bounded `thinking` budget,
and `createAssistantLanguageModel` wraps the AI SDK model so the same value
reaches assistant, task and ingestion calls (`packages/core/src/ai/reasoning.ts`).
It is deliberately not part of the knowledge configuration fingerprint. The
[OpenRouter and route reasoning migration](../packages/db/prisma/migrations/20260925170000_openrouter_and_route_reasoning/migration.sql)
backfills existing route values from their assigned models; the old
`LlmModel.reasoningMode` column remains for rollout compatibility but no longer
drives requests. A [follow-up migration](../packages/db/prisma/migrations/20260925170100_embedding_route_reasoning_default/migration.sql)
sets the embedding route to `provider_default`. `LlmProviderType` also covers `lmstudio`, `ollama`, and
`openrouter`; `LlmModel.upstreamProvider` holds an optional OpenRouter pin.
`KnowledgeGeneration.routeSnapshot` stores the non-secret historical
extraction/embedding route identity for audit; runtime calls and
`AiUsage.connectionId` intentionally resolve the live connection.

Phase 4D added `AssistantConversation`, `AssistantMessage`, `AssistantRun`
(monotonic `nextSequence`, `actorSnapshot`, non-secret `routeSnapshot`),
`AssistantRunAttempt` (worker leases), `AssistantRunEvent`
(`@@unique([runId, sequence])`), `AssistantCitation` (validated locators; no
FK to content), and `AssistantProposal` (one JSON `operation`, preview,
status).

Assistant submission stores selected connection/tool IDs and server-computed reviewed
snapshots in the triggering message (`assistantRuns.ts`).
[`externalTools.ts`](../packages/ai/src/externalTools.ts) adapts selected schemas to
stable `ext_<tool UUID without hyphens>` names, serializes calls, and polls durable
owner approvals within the run deadline. Selection/history checks repeat before
provider creation and external calls; provider retries are disabled for selected
external runs. The runner budgets every selected definition on every model step.
Approval/status events carry identifiers and closed outcomes only; `liveMessage.ts`,
`ToolActivity`, and `RunStateStrip` render the pending state. Interactive selection
and approval controls belong to the assistant UI slice; connections are
configured per user under Account › MCP connections.
Every new runner answer preserves all leased history's project lineage (unknown or
overflow remains null). External source summaries remain separate from native
citations; `hasExternalContext` propagates through subsequent answers and suppresses
provider diagnostic bodies before model construction, including callback scopes.

Phase 7A adds `ExternalMcpConnection`, reviewed `ExternalMcpTool` catalog
entries, a required `ownerId` (personal connections), and ordered
`ScheduledTaskExternalInput` definitions. `ExternalMcpCall` stores
payload-free dispatch history with durable actor, connection, tool, digest, and
scope snapshots; `ExternalMcpToolApproval` separately stores encrypted pending
arguments through approval until settlement (denied, expired, and invalidated
payloads are cleared). Task inputs restrict tool and connection deletion,
while nullable live references let historical calls survive connection removal.

[`externalMcp` management services](../packages/core/src/services/externalMcp.ts)
require the owner (`assertConnectionManager`: a session, or a key/OAuth token with `mcp:use` and `external:manage`; another user's connection is `NOT_FOUND`), use explicit secret-free selects, and serialize configuration
writes with a connection row lock and revision check. Connection detail limits tool
previews to 25; `listExternalTools` pages review-state/effect/name filters with a
100-row ceiling, including retained removed history. Discovery performs transport
work outside transactions, then atomically replaces the bounded catalog only for
the captured revision. `presentInCatalog` fences removed tools; changed/removed
tools retain review history but become disabled. Endpoint edits clear reviews and
presence until rediscovery; canonical redirects are owner-only results requiring
an explicit save. Connections may set `allowInsecureTls` (default off) to skip TLS
certificate validation on their own discovery and tool-call requests.
[`credentials.ts`](../packages/core/src/services/externalMcp/credentials.ts)
binds AES-GCM payloads to separate connection/approval AADs, checks every payload at
web/worker/MCP startup, and rotates with compare-and-swap. Connection-locked
[`approval invalidation`](../packages/core/src/services/externalMcp/approvals.ts)
invalidates pending and approved decisions for prepared calls, clearing arguments
atomically; already-dispatched calls retain their payloads until settlement.

[`externalMcp/access.ts`](../packages/core/src/services/externalMcp/access.ts) lists
eligible tools and reauthorizes execution against live session/task principals,
active owning runs, project roles, connection ownership, and reviewed definitions.
Approval follows [`externalMcp/policy.ts`](../packages/core/src/externalMcp/policy.ts): connections carry no approval setting. The assistant asks before a write tool unless the conversation's Auto-approve is on when the call is prepared; MCP clients and tasks never get a Weaver approval. Migration `20261003090000_drop_external_mcp_approval_policy` removed the per-connection policy.
Assistant invocations require a loaded-tool snapshot in the triggering message's
`content.externalToolSnapshots` (connection/tool IDs, config revision, tool digest),
written by [`runTools.ts`](../packages/core/src/services/externalMcp/runTools.ts)
`loadExternalToolsForRun` under the attempt → run locks (at most 20 per run).
The access dependency accepts a Prisma transaction for dispatch-time checks.
[`historyScope.ts`](../packages/core/src/externalMcp/historyScope.ts) rejects replay
outside the current scope or with unknown lineage. User lineage comes from a valid
scope; assistant `content.contextProjectIds` must persist the full context union
(up to 100 UUIDs, otherwise unknown). Internal replay remains compatible with
legacy answers. [`digest.ts`](../packages/core/src/externalMcp/digest.ts) separates
exact invocation identity from run-wide repeated-denial identity.

[`calls.ts`](../packages/core/src/services/externalMcp/calls.ts) prepares immutable,
fully scoped calls and reuses run-wide denials. Exact identity and effective deadline
are persisted by the additive `20260921000500_external_call_identity` migration;
legacy null identities cannot dispatch. [`approvals.ts`](../packages/core/src/services/externalMcp/approvals.ts)
provides current-owner decisions and encrypted argument reads; historical terminal
states remain readable without arguments after configuration removal.
[`execution.ts`](../packages/core/src/services/externalMcp/execution.ts) claims
prepared→dispatched before HTTP, rechecks the live catalog against the reviewed
schema, and settles metadata without retaining results. Duplicate calls return status
only. `hasExternalDispatch` checks `dispatchedAt`, including completed/failed/unknown
calls; response loss or settlement persistence failure must never trigger replay.
Locks follow attempt→run→connection→call→approval (task run→connection→call).
Configuration/grant changes and cancellation serialize with admission; unrelated
session/member changes committed before the live authorization check reject it,
while concurrent changes may race admission. Tokens recheck endpoint/enabled/revision
on every HTTP request. Both assistant retry branches fence on durable dispatch
under the attempt/run locks; an admitted network request cannot be recalled.
[`retention.ts`](../packages/core/src/services/externalMcp/retention.ts) invalidates
pending approvals on run transitions, settles interrupted dispatched calls as
unknown, and clears encrypted arguments. `reconcileExternalMcpState` runs in
failure-isolated `system.reconcile`: 500-row lifecycle batches and at most 5,000
expired metadata rows per pass, excluding active owning runs. Task calls use their
own task-run lease independently of assistant attempts.
[`DiagnosticContext`](../packages/core/src/diagnostics/context.ts) carries monotonic
`suppressProviderBodies`; provider fetch snapshots it at entry and skips all body
capture while retaining independently available metadata and usage events.

- External tool table and admin MCP tools: bulk review `reviewExternalTools` (`services/externalMcp/catalog.ts`, up to 500, all-or-nothing); `listExternalToolKeys`, `getExternalTool` and the shared tool filter (`toolWhere`) in `services/externalMcp/connections.ts`; pure `externalMcp/toolState.ts`; tRPC `externalMcp.reviewTools` / `toolKeys`; migration `20261001120000_external_mcp_tool_description` adds `ExternalMcpTool.description`; MCP contracts `tools/connections/{read,write}.ts` in `packages/assistant-tools`, using `ToolContext.external` supplied by `packages/mcp`.
- Personal connections: migrations `20261001160000`–`20261001160600` (cleanup of foreign task inputs, `ownerId`, suggested effect on unreviewed tools, write-approval policy and default, grants dropped, suggested-effect back-fill); discovery re-suggests `effect` from `readOnlyHint` while a tool is unreviewed, and the tool filter's `suggestedEffect: "read"` matches the current definition's hint; MCP connection tools in `packages/assistant-tools/src/tools/connections/` (`CONNECTION_TOOLS`, `external:manage`). Every user's connections may reach the origins in `WEAVER_OUTBOUND_ALLOWED_ORIGINS`; everything else must be public HTTPS.
- Inbound MCP access: `services/externalMcp/inbound.ts` lists the credential owner's enabled tools on every policy, without a project argument, and calls them for `external:use` credentials as the `mcp` execution owner; calls record scope `all`; `packages/mcp/src/externalTools.ts` registers them per request.

The [`assistant_acceptance_claim`](../packages/db/prisma/migrations/20260912000000_assistant_acceptance_claim/migration.sql)
migration adds durable `accepting` proposals. The
[`repair_document_keyword_projection`](../packages/db/prisma/migrations/20260912000100_repair_document_keyword_projection/migration.sql)
migration invalidates live ready keyword states for reconstruction with title-preserving
headings and restores legacy missing chunks through reconciliation.

Phase 4F added `McpOperation` for durable user-scoped idempotency and
`McpAuditEvent` for payload-free protocol auditing. OAuth consent authority is
now generation-bound: access and refresh tokens must name the exact live
`OauthConsent.referenceId`, including the consent's scopes and resources.
Expired `dpop-proof:` rows in Better Auth's `Verification` table are pruned
before a new replay reservation; a prefix-partial expiry index keeps that
cleanup away from live DPoP and unrelated verification rows.

The diagnostics foundation adds the generic `SystemSetting` JSON row and
append-only `DiagnosticEvent` rows without foreign keys. Diagnostic settings
are validated in [`diagnostics/settings.ts`](../packages/core/src/diagnostics/settings.ts),
read through the 15-second process cache in
[`diagnosticsSettings.ts`](../packages/core/src/services/diagnosticsSettings.ts),
and persisted through [`systemSettings.ts`](../packages/core/src/services/systemSettings.ts).
[`diagnostics/context.ts`](../packages/core/src/diagnostics/context.ts) carries
correlation ids across async calls; [`events.ts`](../packages/core/src/diagnostics/events.ts)
owns the event/category catalog. Writer, settings-cache, and context state live
on `globalThis` symbols through
[`processState.ts`](../packages/core/src/diagnostics/processState.ts), because
Next.js loads `instrumentation.ts` and route handlers as separate module copies.
The [`writer.ts`](../packages/core/src/diagnostics/writer.ts)
sanitizes and queues enabled events, batches inserts in the background, and
bounds shutdown to five seconds. Its final counters retain timeout drops until
the next start; an insert still pending at that deadline has an unknown database
outcome and counts as dropped locally. Each process supplies `createdAt`
explicitly in UTC; the follow-up
[`20260910090100_diagnostics_event_created_at_utc`](../packages/db/prisma/migrations/20260910090100_diagnostics_event_created_at_utc/migration.sql)
migration removes the original database default. The follow-up
[`diagnostic filter indexes`](../packages/db/prisma/migrations/20260914000300_diagnostic_filter_indexes/migration.sql)
cover event, severity, user, and connection filters.
[`OAuth UTC triggers`](../packages/db/prisma/migrations/20260914000200_oauth_revoked_utc/migration.sql)
normalize live revocation timestamps independently of the database session timezone.

## Web adapters and UI

`lib/editor/link-base-path.ts` normalizes document and assistant link marks before
static rendering. Local document image resolution deliberately rejects external
sources unsupported by CSP. `trpc/logger.ts` logs only operation metadata, redacting
all payloads even for future routers; API-key policy forms are disabled while saving.
ZIP Replace carries the previewed `expectedHeadCommitSha` through multipart parsing.

[`proxy.ts`](../apps/web/src/proxy.ts) enforces a fresh nonce-based script CSP on
page requests, including login and consent. The root layout passes the nonce to
next-themes. [`api/csp-report`](../apps/web/src/app/api/csp-report/route.ts) accepts
bounded, rate-limited reports and records only the violated directive. Permissions
Policy disables camera, microphone, and geolocation; TLS/HSTS belong to the edge.
Workspace/global error boundaries and a not-found page offer recovery routes.

[`TRPCReactProvider`](../apps/web/src/trpc/react.tsx) keeps the editor mounted on
session expiry or session-query errors and offers sign-in in a new tab. A different
non-null principal still replaces the client cache. Queries do not retry 4xx
responses; sensitive router paths never enter the debug logger. API-key policy
editing waits for a successful project-list response. Project and membership
mutations refresh the landing-project cache; inaccessible projects hide sections.

The `externalMcp` tRPC router adapts owner-scoped connection/catalog services and
session-scoped availability/approval services. Its runtime dependencies are composed
in [`externalMcp.ts`](../apps/web/src/server/externalMcp.ts), marked server-only so
encryption keys and transport code cannot enter client bundles. Account › MCP
connections provides paged configuration, explicit redirect acceptance, reviewed
tool schemas/classification/enabling, and each user's own exact-call approvals.

[`proxy.ts`](../apps/web/src/proxy.ts) overwrites an internal request-path header
so the workspace session gate preserves a validated login callback. Request-scoped
session reads share React caching. Shared client date/mount primitives keep account
dates and notifications hydration-safe; dashboard and member lists distinguish
errors from empty results and retain retry controls.

The admin `oidc` router delegates settings read/test/update to
[`oidcSettings.ts`](../packages/core/src/services/oidcSettings.ts). The
`auth.oidc` SystemSetting stores a revision and encrypted credential;
[`oidc/credentials.ts`](../packages/core/src/services/oidc/credentials.ts)
participates in startup key checks and secret rotation.
Startup validates the credential envelope separately, so malformed provider
metadata disables OIDC while password login remains available. Migration
[`20261018090000_oidc_account_issuer_guard`](../packages/db/prisma/migrations/20261018090000_oidc_account_issuer_guard/migration.sql)
serializes OIDC account identity writes with settings updates and rejects an
admitted callback if another issuer was committed before its account insert.

OIDC discovery metadata and its bounded, guarded HTTP reader live in
[`config/oidc.ts`](../packages/config/src/oidc.ts) and
[`config/oidcDiscovery.ts`](../packages/config/src/oidcDiscovery.ts).

Authentication is Better Auth email/password plus optional OIDC with database sessions. The
shared instance factory lives in
[`packages/auth/src/index.ts`](../packages/auth/src/index.ts); the web app
mounts it with `nextCookies()` in
[`apps/web/src/server/auth/index.ts`](../apps/web/src/server/auth/index.ts)
and serves it from `/api/auth/[...all]`. Every request becomes an immutable
`SecurityContext`
([`packages/core/src/security/context.ts`](../packages/core/src/security/context.ts));
services intersect capability, credential project restriction, organization
membership, and role in
[`projectAccess.ts`](../packages/core/src/services/projectAccess.ts). Each
project owns exactly one Better Auth organization whose `Member` rows are
written only by core services; non-members — including global Admins —
receive `NOT_FOUND`.

Optional external login uses request-scoped provider loading in
[`packages/auth/src/oidc.ts`](../packages/auth/src/oidc.ts) and guarded token/JWKS
transport in [`oidcProvider.ts`](../packages/auth/src/oidcProvider.ts). The web
composition root [`server/oidc.ts`](../apps/web/src/server/oidc.ts) resolves
persisted settings, falling back to `WEAVER_OIDC_*` only when no row exists.
Saved changes take effect on the next OIDC request without rebuilding Better
Auth or restarting web. A server-controlled OAuth-state generation rejects
callbacks started before a material configuration change. The first save of
environment settings also invalidates old flows. Label edits compare canonical
authentication metadata so reordered capability lists preserve flows. The login
page exposes only the display name; the callback remains
`<origin><base path>/api/auth/callback/oidc`. Verified ID-token email enables
first-login provisioning or same-email linking; issuer/subject identifies the
account and provider claims cannot grant roles. Upstream access/refresh tokens
remain encrypted with Better Auth's AUTH_SECRET. Password and session reads do
not depend on discovery. See [`oidc.spec.ts`](../apps/web/tests/integration/oidc.spec.ts),
[`oidcSettings.spec.ts`](../apps/web/tests/integration/oidcSettings.spec.ts),
[operator setup](setup.md#oidc-sign-in-authentik), and `weaver-oidc`.

Administration configuration is grouped under
[`admin/settings/layout.tsx`](<../apps/web/src/app/(workspace)/admin/settings/layout.tsx>),
with link-based AI, Remote Instances and OIDC tabs. Legacy `/admin/ai` and
`/admin/remote-instances` pages redirect with their query parameters preserved.
The sidebar exposes one Settings entry in expanded and collapsed navigation.

The OIDC Settings tab renders `OidcSettingsScreen` and its guarded edit form
under `admin/settings/oidc/_components/`. Test uses the unsaved discovery URL
without credentials or writes; metadata is displayed by `OidcMetadataPanel`.
Save adopts the returned revision, clears replacement secrets and keeps accepted
writes locked during refresh recovery.

Generic Better Auth organization reads and mutations are disabled; content
metadata goes through live-project policy. [`users.ts`](../packages/auth/src/users.ts)
hashes credentials before transactional user/account writes. The single-operator
[`bootstrapAdmin`](../packages/auth/src/bootstrap.ts) supports an explicit,
narrow orphan recovery option; see [setup](setup.md#first-admin-on-a-deployed-instance).

Global user management (Phase 7 scope pulled forward, implemented ahead of
Phase 6)
lets an Admin create, find, and administer accounts once `bootstrapAdmin` has
created the first one, without opening any `/admin/*` HTTP route.
[`adminUsers.ts`](../packages/auth/src/adminUsers.ts) (`createUserAdministrator`)
wraps the admin plugin: `create` calls `auth.api.createUser` as a trusted
headerless server call (the mechanism `createApiKeyIssuer` already uses for
`auth.api.createApiKey`), while `setRole`, `ban`, `unban`, `setPassword`, and
`revokeSessions` run behind `adminMiddleware`, which has no headerless escape,
so they operate directly on the plugin's own `internalAdapter`/`password`
primitives instead — `DISABLED_ADMIN_PATHS` is unchanged either way. Policy and
invariants live in [`users.ts`](../packages/core/src/services/users.ts):
`assertSystemAdmin` gates every operation, an Admin cannot deactivate or
demote themselves or reset their own password here, and the set of active
(`role = Admin, banned = false`) Admins can never reach zero, serialized
through `lockGlobalAdminRoster`. `setUserMembership` is a deliberate bounded
narrowing of reconciliation spec §6.1: it skips `assertProjectRole` so an
Admin can restore access to a project they do not belong to, but refuses
outright when the target is the acting Admin. The `user` tRPC router
(`apps/web/src/server/api/routers/user.ts`) exposes all of this through
`adminProcedure`. `User.mustChangePassword` (declared to Better Auth via
`user.additionalFields` so it reaches `SessionUser`) is set on admin-created
and admin-reset accounts; `requireActiveUser`
(`apps/web/src/server/api/trpc.ts`) rejects every procedure except
`account.me`/`account.changePassword` while it is set, and the assistant SSE
stream and ingestion upload routes carry the identical check by hand outside
tRPC. The OAuth consent page carries the same check by hand too, but reacts
differently: rather than a plain 403, it denies the in-flight authorization
the way its own "Deny" button would
(`apps/web/src/app/(auth)/consent/mustChangePasswordGate.ts`) before ever
rendering the form, so a flagged user can never approve a grant — including
`content:write`, which MCP requests reach without passing through
`requireActiveUser` at all — and the waiting client gets a proper
`access_denied` redirect instead of a hang. Two shared-auth pieces in
`createWeaverAuth` make that page the only OAuth exit for a flagged user: the
Better Auth before hook rejects every other cookie-authenticated route except
an exact allowlist
([`passwordChangeGate.ts`](../packages/auth/src/passwordChangeGate.ts):
sign-in, `get-session`, `sign-out`, `change-password`, `/oauth2/authorize`,
and a consent denial), and the OAuth provider's `postLogin.shouldRedirect`
sends a flagged user's `/oauth2/authorize` to the consent page ahead of the
provider's existing-consent shortcut. Session and bearer boundaries reject the
flag, and `resetUserPassword` also revokes the user's API keys and OAuth grants
(`revokeAllOAuthGrantsForUser` in
[`oauthConsents.ts`](../packages/core/src/services/oauthConsents.ts))
atomically with setting the flag; they do not return after the forced
change. `account.changePassword` calls
[`passwordChange.ts`](../packages/auth/src/passwordChange.ts)
(`createPasswordChanger`), which is the self-service counterpart and, unlike
the admin port, calls Better Auth's in-process `/change-password` handler
with the caller's real headers; its public HTTP route remains disabled.
Self-service password changes and deactivation also revoke API keys and OAuth
grants, so reactivation cannot resurrect them. `/update-user` is disabled to keep
profile names inside the validated administration path. Without trusted proxy
headers, sign-in uses Better Auth's shared per-path rate-limit fallback. UI: Administration › Users
(`apps/web/src/app/(workspace)/admin/users/`) — a list with create and a
one-time password reveal inside the create dialog (copy/select until Done,
then cleared), plus a `[userId]` detail route with Account/Access/
Memberships cards — and `/account/password`
(`apps/web/src/app/(workspace)/account/password/`), reached by a forced
redirect from the workspace layout. Administration › Projects
(`apps/web/src/app/(workspace)/admin/projects/`) lists every non-deleted project
with owners, member count and document/table counts through the admin-only
`adminProject` router ([`adminProjects.ts`](../packages/core/src/services/adminProjects.ts)),
which never returns content. Its `[adminProjectId]` detail route (named so
workspace chrome does not treat it as an open project) manages other users'
membership through `user.setMembership`. Seven `admin.user.*` diagnostic events
cover every mutation without ever logging a password. User deletion is out of
scope; removal is deactivation, a complete kill switch enforced by the shared
auth hook (sessions) and `packages/core/src/security/bearer.ts` (API keys and
OAuth tokens, on their next use). The admin project picker is capped at 1,000
rows. Accepted administrator, membership, role and same-origin trust boundaries
are documented in [setup](setup.md#credential-and-deployment-trust-boundaries).

The browser [`TRPCReactProvider`](../apps/web/src/trpc/react.tsx) keys its cache
and child state by principal and cancels/clears the old client on identity
changes. Authentication transitions reload the document. Definite access
errors hide cached content. Programmatic navigation shares the editor guard
in [`use-unsaved-changes-guard.ts`](../apps/web/src/lib/use-unsaved-changes-guard.ts).
Assistant composers are conversation-keyed and submission callbacks use the
submitted identity; pending sends/settings saves disable draft editing.

Personal API keys (spec §8) are minted, updated (`apiKey.update`: name, capabilities, projects, rate limit; never the secret or expiry) and revoked only through the `apiKey` tRPC router
→ [`packages/core/src/services/apiKeys.ts`](../packages/core/src/services/apiKeys.ts)
→ Better Auth (`createApiKeyIssuer`). Keys carry `mcp:use` + `content:read` by
default, `content:propose`/`content:write`/`ingest:external` explicitly (the
last is the external feed channel and never a session or OAuth capability), and
Weaver-owned project restrictions in `ApiKeyProject`; an omitted custom limit keeps Better
Auth's 10,000-request/minute default and fail-closed disabled keys remain
visible as disabled. The plugin's own `/api-key/*` routes are disabled. The MCP
setup help on Account › API keys
([`McpSetupHelp.tsx`](<../apps/web/src/app/(workspace)/account/api-keys/_components/McpSetupHelp.tsx>))
uses the configured `MCP_RESOURCE_URL` and offers copyable API-key setup for
Claude Code, Codex, OpenCode, Claude Desktop (`mcp-remote`), and ChatGPT Desktop
(shared Codex configuration), with links to client documentation.
Project machine credentials use separate `ProjectApiKey`/`ProjectApiKeyGrant`
models and [`ProjectMachineContext`](../packages/core/src/security/projectMachine.ts),
with an immutable project binding and no user authority. Their secret prefix is
`wvr_project_`; [`credentials.ts`](../packages/core/src/projectApi/credentials.ts)
stores only SHA-256 digests, and [`rateLimit.ts`](../packages/core/src/projectApi/rateLimit.ts)
enforces an atomic UTC minute window. Creator references use SetNull and do not
control access. Operation reservations, metadata-only audits and rate windows
are project-owned; content projections have nullable machine-author fields.
Grantable non-root folders carry a stable optional UUID in `.folder.json`;
[`folderIdentity.ts`](../packages/core/src/projectApi/folderIdentity.ts) resolves
bounded maps at captured HEAD and assigns legacy identities without changing
stamps. Rename/move and metadata updates retain IDs; copying/recreating folders
allocates fresh IDs. Missing or duplicate identities never fall back to paths.

The MCP OAuth 2.1 foundation (spec §9) is the `@better-auth/mcp`
provider plus `@better-auth/cimd` discovery (no dynamic client registration):
`/api/auth/oauth2/{authorize,consent,token,…}`, `/api/auth/jwks`, and the root
discovery routes under
[`apps/web/src/app/.well-known/`](../apps/web/src/app/.well-known/). The
consent page is
[`apps/web/src/app/(auth)/consent/`](<../apps/web/src/app/(auth)/consent/>);
the login form resumes an authorization via the signed `oauth_query`; CIMD
redirect, logout, and client URIs are origin-bound with the native-client
loopback/private-use exceptions. One live `OauthConsent` exists per user/client;
its immutable generation is propagated through refresh tokens and a private
access-token claim. Authorization-code, access-token, and refresh-token inserts
lock that exact consent row, while the MCP boundary rechecks the live generation
plus granted scopes/resources, so revoke and narrower re-consent cannot revive
old authority.
A write-locked forward cutover rotates every consent generation and revokes
every token family present once; clients must reauthorize, while grants created
after the cutover are unchanged.
Signed-in users list/revoke grants through the session-only `oauthConsent`
router/service at `/account/connected-apps`. At the MCP gate,
`resolveMcpPrincipal` turns a verified bearer credential into a
`SecurityContext` (`authenticationMethod` `apiKey`/`oauth`), requires
`mcp:use`, and, for OAuth, requires the exact live consent generation with
scope/resource containment. Legacy non-MCP bearer callers use
`resolveBearerSecurityContext`. API-key management lives at
`/account/api-keys`.

tRPC schemas and thin routers live under
[`apps/web/src/server/api/`](../apps/web/src/server/api/). They call services in
[`packages/core/src/services/`](../packages/core/src/services/) for projects,
members, Git-backed documents/tables and folders, typed references, knowledge
indexing, search, and graph queries. The public HTTP routes are Better Auth
(`/api/auth/*`), `/api/trpc/[trpc]`, the unauthenticated liveness endpoint
[`/api/health`](../apps/web/src/app/api/health/route.ts),
[`/api/documents/[documentId]/images`](../apps/web/src/app/api/documents/[documentId]/images/route.ts)
(Editor multipart upload, sniffed PNG/JPEG/WebP/GIF, capped by
`WEAVER_DOCUMENT_IMAGE_MAX_BYTES`), and
[`/api/projects/[projectId]/files/[...path]`](../apps/web/src/app/api/projects/[projectId]/files/[...path]/route.ts)
(Viewer-gated committed blob read with an `ETag` and an optional `?at=<sha>`),
and [`/api/documents/[documentId]/pdf`](../apps/web/src/app/api/documents/[documentId]/pdf/route.ts)
(Viewer-gated PDF of the saved revision: `server/documents/pdf/export.ts` reads
the document, inlines its images as `data:` URIs and current cross-reference
titles, `html.ts` renders the viewer markup with a fixed light print
stylesheet, `render.ts` prints A4 through `playwright-core` Chromium one render
at a time per process with a queue of four and `WEAVER_PDF_TIMEOUT_MS`;
`runtime.ts` reports whether Chromium is available, cached like the Git check,
and the workspace layout hands it to the Export as PDF item of the document actions menu).
Two more Viewer-gated downloads come from
[`services/documentDownload.ts`](../packages/core/src/services/documentDownload.ts):
[`/api/documents/[documentId]/markdown`](../apps/web/src/app/api/documents/[documentId]/markdown/route.ts)
returns the committed `.md` blob byte for byte as `<slug>.md`, and
[`/api/projects/[projectId]/folders/archive`](../apps/web/src/app/api/projects/[projectId]/folders/archive/route.ts)
(`?path=a/b`, no path for the project root) streams a ZIP of one pinned
revision. [`documents/archive.ts`](../packages/core/src/documents/archive.ts)
selects the files and
[`documents/archiveZip.ts`](../packages/core/src/documents/archiveZip.ts)
writes them, reading one blob at a time. The documents explorer links to both
through [`lib/documents/download.ts`](../apps/web/src/lib/documents/download.ts)
and puts the document link on the drag payload
([`lib/explorer/drag.ts`](../apps/web/src/lib/explorer/drag.ts)).
[`/api/documents/[documentId]/archive`](../apps/web/src/app/api/documents/[documentId]/archive/route.ts)
(`createDocumentArchive`) streams one document as a ZIP with `<slug>.md` and
its `<slug>.assets/` images at the archive root; the explorer item menu and
the document actions menu (`DocumentActionsMenu`) link to it.
The reader mapping and the editor's `DocumentImage` extension resolve relative
image sources through
[`image-url.ts`](../apps/web/src/lib/documents/image-url.ts) only when producing
DOM; the stored `src` stays the relative repository path.
The persistent editor's [`DocumentImageNodeView`](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/DocumentImageNodeView.tsx>)
receives the current saved path through its provider so image URLs follow renames
and moves without recreating the editor. It also resizes: a selected image has
drag handles and size buttons, and the pixel width is stored in the Markdown
as an `<img … width="N">` tag, the only HTML the parser reads
([`imageTag.ts`](../packages/core/src/editor/imageTag.ts)).

Document-folder review defaults live in Git `.folder.json` metadata
([`folderMetadata.ts`](../packages/core/src/documents/folderMetadata.ts)); the
nameless document root uses a separate defaults-only parser and writer. Folder
trees expose `folderReviewDefaults` for normal document folders and optional
`rootReviewDefaults` separately from visible names, stamps and appearances.
[`folderReview.ts`](../packages/core/src/documents/folderReview.ts) normalizes the
existing reviewer references and selects the nearest whole-path ancestor; an
explicit empty list stops inheritance. Folder rename/move and
[`folderMetadataUpgrade.ts`](../packages/core/src/services/folderMetadataUpgrade.ts)
preserve defaults and appearance while updating or backfilling stamps.
[`folders.ts`](../packages/core/src/services/folders.ts) reads both kinds at a
captured Git revision, including the shared `readRootFolderMetadataAt` helper.
[`services/folderReview.ts`](../packages/core/src/services/folderReview.ts) owns
`folder.reviewDefaults`, `previewReview`, `setReviewRecursively` and
`clearReviewDefault`. A shared preparation validates Git descendants and current
reviewer targets before a guarded single-commit assignment; it clears child
defaults and caps actual document rewrites at 1,000 / 50 MiB. Each composed file
also passes the ordinary writer's `documents.assertDocumentFileSize` guard
(2,000,000 UTF-8 bytes), shared with single-document review changes. Clear affects only
the selected default. Mutations strictly reject malformed stored review defaults;
ordinary reads retain tolerant normalization. Default reads return both effective
`reviewers` and `configuredReviewers`, preserving empty and unresolved selections
from the same chosen configuration. Project configuration reads and materialization
stay in [`reviewerGroups.ts`](../packages/core/src/services/reviewerGroups.ts).
Committed metadata is projected by
`documents.projectPreparedDocumentInRepo`, sharing normal reviewer/link sync,
index signals and post-commit reconciliation without rescanning Git per document.
The same service's `previewFolderMarkReviewed`/`markFolderReviewed`
(`folder.previewMarkReviewed`, `markReviewedRecursively`) mark every subtree document
the actor is an effective reviewer of as reviewed in one commit and skip the rest;
any member may call them, and
[`MarkFolderReviewedDialog.tsx`](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/MarkFolderReviewedDialog.tsx>)
confirms the counts first ("Mark all as reviewed" in folder menus and at the root).

The documents-only
[`FolderReviewDialog.tsx`](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/FolderReviewDialog.tsx>)
shows configured/effective defaults and inheritance, then previews the selected
replacement before explicit Apply with that preflight HEAD. Folder menus and the
adapter's optional `rootActions` entry point expose it to Owners/Maintainers,
without adding a visible root folder or a Tables action. Selection changes cancel
obsolete previews, and preview-specific zero stale time forces a new preflight
when revisiting a cached selection. Conflicts retain the draft and require a
refreshed preflight. Accepted writes with failed cache refresh keep writes disabled;
Refresh retries canonical invalidations and closes only after recovery.
Clear guards the defaults read HEAD and leaves existing documents unchanged.
[`invalidateFolderReview`](../apps/web/src/lib/documents/review-cache-invalidation.ts)
refreshes defaults, document reads/lists/history/permissions and review lists/counts;
dirty editors keep their own baseline and ordinary save conflict guard.

The shared [`query-client.ts`](../apps/web/src/trpc/query-client.ts) publishes access
errors without retry backoff, allowing cached views to hide revoked data or lock a
local document draft immediately. Transient browser failures retain three retries.

Workspace UI lives under
[`apps/web/src/app/(workspace)/`](<../apps/web/src/app/(workspace)/>).
Canonical feature roots are:

- documents: [`projects/[projectId]/documents/`](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/>);
- tables: [`projects/[projectId]/tables/`](<../apps/web/src/app/(workspace)/projects/[projectId]/tables/>);
- graph and provenance: [`projects/[projectId]/graph/`](<../apps/web/src/app/(workspace)/projects/[projectId]/graph/>);
- project/member and index operations: [`projects/[projectId]/settings/`](<../apps/web/src/app/(workspace)/projects/[projectId]/settings/>);
- global search and application shell: [`_components/`](<../apps/web/src/app/(workspace)/_components/>).

Reusable browser-only utilities remain in
[`apps/web/src/lib/`](../apps/web/src/lib/); graph canvas styles, spacing, and
viewport fitting live in
[`knowledge/graphCanvas.ts`](../apps/web/src/lib/knowledge/graphCanvas.ts).
Transport-independent Markdown,
table, knowledge, role, AI, and service code lives in
[`packages/core/src/`](../packages/core/src/).

The shared [document extensions](../packages/core/src/editor/extensions.ts)
allow inline code to coexist with emphasis and links, preserving valid Markdown
through import acceptance, validation, and editor round trips.

Documents and Tables both list their folder's contents through the shared
[`ContentExplorerScreen`](../apps/web/src/components/explorer/ContentExplorerScreen.tsx)
/[`ContentExplorer`](../apps/web/src/components/explorer/ContentExplorer.tsx),
driven by an [`ExplorerAdapter`](../apps/web/src/components/explorer/adapter.ts)
(tree query, item columns/badges, folder/item actions, create dialogs, copy,
optional drop-zone import) that each area supplies —
[`documentsExplorerAdapter`](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/documentsExplorerAdapter.tsx>)
and
[`tablesExplorerAdapter`](<../apps/web/src/app/(workspace)/projects/[projectId]/tables/_components/tablesExplorerAdapter.tsx>).
The screen keeps folder state in the `?folder=` query (pushed on navigation
rather than held in local state); the kind-agnostic folder/search/sort helpers
live in
[`lib/explorer/entries.ts`](../apps/web/src/lib/explorer/entries.ts), and each
area's `lib/{documents,tables}/explorer.ts` re-exports its item type and href
helpers over that shared module. Entries render as a list or as icons with
roving keyboard focus
([`lib/documents/use-roving-focus.ts`](../apps/web/src/lib/documents/use-roving-focus.ts),
shared by both adapters): arrow keys move, Enter opens, Backspace/Alt+Up go to
the parent folder; the view choice persists per adapter
(`adapter.viewStorageKey`). There is no folder sidebar or tree column for
either area.

Both views select visible entries without checkboxes: Ctrl/Cmd+click toggles,
Shift+click adds the range from the last toggled entry, Space/Shift+Space do the
same from the keyboard, Ctrl/Cmd+A selects all and Escape clears. The bulk
actions bar offers Select all and shows the gesture hint while nothing is selected.
[`ExplorerBulkActions`](../apps/web/src/components/explorer/ExplorerBulkActions.tsx)
previews move/delete/review confirmations; the adapter's `useOperations` uses
[`useExplorerOperations`](../apps/web/src/components/explorer/useExplorerOperations.ts)
to reuse the existing authorized document/table/folder endpoints. Batches run
serially, retain failures for retry, and refresh canonical caches after writes.
Review previews filter effective reviewers and capture document revisions;
table deletion also captures revisions before confirmation. Assigned Viewer
reviewers can select/review, while only Editors can move/delete. Folder and
selection drags use project-scoped identities in
[`drag.ts`](../apps/web/src/lib/explorer/drag.ts); normalization and destination
checks live in [`selection.ts`](../apps/web/src/lib/explorer/selection.ts).
Folders move with descendants once; deletion still requires empty folders.

Portable optional appearance metadata is shared by documents, folders and tables
([`appearance/metadata.ts`](../packages/core/src/appearance/metadata.ts),
[`appearance/icons.ts`](../packages/core/src/appearance/icons.ts)). It lives in
an optional JSON `appearance` line in the version-3 document comment, in
`.folder.json`, or in `schema.json`; absent or invalid optional fields keep
content readable, and serialization omits empty appearance. Six-digit colors
normalize lowercase; icons use the finite builtin allowlist, one grapheme of
at most 64 UTF-8 bytes without controls, or a lowercase SHA-256 image reference
(`png`/`jpg`/`webp`) at `.weaver-icons/<digest>.<extension>`. Image paths stay
outside table leaves. `Document.appearance` and `DataTable.appearance` are
nullable JSON projection slots (migration
[`20261008120000_content_appearance`](../packages/db/prisma/migrations/20261008120000_content_appearance/migration.sql)); Git remains authoritative.

[`contentAppearance.ts`](../packages/core/src/services/contentAppearance.ts) owns
Viewer reads and Editor metadata-only writes for documents, tables and scoped
folders (`appearance.get`/`set`, [`appearance.ts`](../apps/web/src/server/api/routers/appearance.ts)).
It rechecks access and the loaded item revision (folder writes use project HEAD)
under the project Git lock. Uploaded PNG/JPEG/WebP icons are limited to 2 MiB;
asset bytes and metadata share one commit, with pre-commit rollback through
Git-store `resetWorktreeTo` and containment-checked `removeUntrackedFile`.
[`appearanceAssets.ts`](../packages/core/src/services/appearanceAssets.ts) validates
committed icon bytes, digests and types; the dedicated
[`icons route`](../apps/web/src/app/api/projects/[projectId]/icons/[filename]/route.ts)
rechecks membership before ETag/304 responses. The
[`appearance upload route`](../apps/web/src/app/api/projects/[projectId]/appearance/route.ts)
authorizes the path project before reading a bounded multipart body. Omitted patch
fields preserve current values; null resets only the selected field. Clearing an
icon retains immutable assets needed by other items or historical revisions.
These Git assets are separate from Files artifacts and their blob-store quota.

Document/table projection writers and rebuilds mirror appearance; item lists and
folder trees return normalized appearance (`folderAppearances` is keyed by scoped
folder path at the captured tree revision). The nameless document root cannot be
styled; the tables root uses key `""` and `tables/.folder.json`. Content and review
writes preserve appearance; content restore keeps the current style, deleted-content recovery
keeps the recovered style, and a stale table merge uses the current Git schema's
appearance independently of its content merge. `.weaver-icons` is excluded from
content folder discovery, document indexing/recovery and ordinary file serving.

ZIP downloads select normalized folder metadata and deduplicated referenced icons
at one revision through `collectAppearanceAssetsAt`; icons stay at archive-root
`.weaver-icons/` while folder content is rebased beneath its wrapper.
[`documentImport.ts`](../packages/core/src/services/documentImport.ts) preserves
appearance on new imports, retains destination appearance on ZIP Replace, and
returns optional warnings for missing plain-Markdown icons. The existing multipart
import route accepts `folderMetadata` and `icon` parts plus additive `mode=folders`
for empty folders. `folders.stageFolderInRepo` shares folder validation/staging with
normal creates; icons, new folder markers and content enter the same import commit.
`appearanceAssets.withAppearanceAssetsInRepo` validates references and rolls back
all touched files on pre-commit failure. Existing folders remain unchanged.
Failures after a create/import commit preserve accepted content and icons.
Remote document/table payloads carry optional appearance and digest-checked icon
bytes; `whoami.capabilities.contentAppearance=1` gates image-bearing sends before
content POST. Legacy text-only payloads remain accepted, and CSV stays data-only.
Table reads return the captured project `snapshotCommitSha` separately from the
item `baseCommitSha`; transfers resolve appearance and icons at that snapshot,
including assets repaired after the table's last schema/data commit.

The shared [`AppearanceDialog`](../apps/web/src/components/appearance/AppearanceDialog.tsx)
fetches metadata and its revision on opening, submits only dirty fields, and
uploads images and the patch in one multipart request. Editor menu actions keep
dialog state outside the closing dropdown portal; demotion discards that state.
[`AppearanceIcon`](../apps/web/src/components/appearance/AppearanceIcon.tsx) contains
images and falls back to the item-kind icon on load failure;
[`appearance-style.ts`](../apps/web/src/components/appearance/appearance-style.ts)
chooses black or white text by relative luminance. Both explorer views apply the
background, with neutral surfaces for badges and action controls; reader/editor
canvases and table cells keep their theme. Icon view adds
Standard (40 px) and Compact (24 px, denser columns) controls, retaining names,
metadata, roving focus and drag/drop. Size persists at
`<adapter.viewStorageKey>:iconSize`; the initial render is Standard and storage
restores after mount, with usable defaults when storage is blocked.

A document file starts with a hidden `<!-- weaver … -->` comment holding
`id`, `created`, `createdBy`, `updated`, `updatedBy` and the review block
(`reviewers`, `reviewEvery`, `reviewSince`, and once reviewed `lastReviewed` and
`reviewedBy`; header version 3), followed by the title as
the leading `# ` heading and the body
([`frontmatter.ts`](../packages/core/src/documents/frontmatter.ts), migration
`20260928120000_document_authorship`), so other Markdown viewers show the title
and hide the metadata. Documents have a kind
([`documents/kinds.ts`](../packages/core/src/documents/kinds.ts): `markdown` →
`.md`, `python` → `.py`), mirrored in `Document.kind` (migration
`20261012090000_document_kind`). `composeDocumentFile`/`parseDocumentFile` take
the kind: a Python file carries the same fields in a `# weaver` … `# /weaver`
comment block (title as a `# title:` JSON line) after an optional shebang.
Python content is plain text (`content: { kind: "python", text }` on
`document.get`/`document.update`), validated by
[`documents/text.ts`](../packages/core/src/documents/text.ts). Revisions written before header version 2 used YAML
frontmatter, and version 2 headers have no review block; parsing still reads
both. Writes default them to
now/the actor; MCP writes and assistant proposals may set them through an
optional `metadata` object (`resolveDocumentMetadata` in
[`contentOperations.ts`](../packages/core/src/services/contentOperations.ts)),
recorded as a `Weaver-Metadata-Override` commit trailer. The `Document`
projection mirrors them (`createdById`/`createdByName`/`updatedAt`/…), while
`lastEditedAt` keeps meaning the last commit. Older files are rewritten into the
current format, with authors from Git history and the project's default review
block, by
[`upgradeDocumentHeaders`](../packages/core/src/services/documentHeaderUpgrade.ts)
in `system.reconcile` (`Project.documentHeaderVersion`, migration
`20260928140000_document_header_version`). Rows whose file no longer parses
are named `Unknown author` so the project leaves the pending set. The upgrade
commit changes every blob, but keyword sync
([`keywordIndex.ts`](../packages/core/src/services/keywordIndex.ts) →
`preserveMovedDocumentKnowledge`) carries vectors and graph evidence across any
commit whose chunks are identical, so it extracts nothing again. The document
header, the documents explorer, `read_document` and `list_documents` show all
four fields.

The Documents adapter's `folder.tree` returns three index lights per document
(`documents/indexLight.ts`) computed from `DocumentIndexState` and the primary
generation's `KnowledgeGenerationDocument` row; the explorer polls the tree
every 30 s while visible. `document.importFile`
(`services/documentImport.ts`) takes the kind from the file name
(`.md`/`.markdown`/`.py`), refuses binaries and control characters, defaults a
Python title to the file stem
([`importPython.ts`](../packages/core/src/documents/importPython.ts)), and for Markdown strips
a leading frontmatter block or Weaver comment header, derives the title (frontmatter `title`, else a leading `# `
heading, else the file name) and creates the document
through the normal create tail; the explorer's drop zone calls it per file.
A dropped `.zip` opens `ImportZipDialog` instead: the browser reads the ZIP
([`zip-import-read.ts`](../apps/web/src/lib/documents/zip-import-read.ts)),
[`zip-import.ts`](../apps/web/src/lib/documents/zip-import.ts) pairs documents
with their images, plans target folders and finds collisions against the
loaded tree, and
[`zip-import-upload.ts`](../apps/web/src/lib/documents/zip-import-upload.ts)
posts documents and empty-folder metadata through the same route at
[`/api/projects/[projectId]/documents/import`](../apps/web/src/app/api/projects/[projectId]/documents/import/route.ts).
The route bounds and parses the form
([`archiveImportFields.ts`](../apps/web/src/server/documents/archiveImportFields.ts))
and calls `importDocumentArchiveEntry` (`services/documentImport.ts`), which
stages missing folders and writes the document with its images and appearance
assets in one commit, as a new document or onto an existing one. Folder-only
requests use `importArchiveFolders` and preserve existing folder metadata.
`DocumentsWorkspace` owns the shared page header, scrolling canvas, and context
rail. Its header holds a stable toolbar portal target on the left and Context
controls on the right; the phone opens Context in a drawer. Collapsing the rail
keeps its Contents/Links/History/Index tabs mounted and preserves the toolbar
target. The Contents tab (the default;
[`DocumentOutlinePanel`](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/DocumentOutlinePanel.tsx>))
lists top-level headings with text under their canonical section anchors
(`documentOutline` in
[`lib/editor/document-heading-anchors.ts`](../apps/web/src/lib/editor/document-heading-anchors.ts)).
Editors read the live outline from the section-anchor plugin state
(`documentOutlineFromState`, the same array until a heading changes); viewers
and diffs use the saved content. A click feeds a `jump`-counted
`DocumentSectionNavigation` through the normal section navigation, which scrolls
it to the top below the sticky title (`scroll-margin-top`), and the panel marks
the section being read while it is visible
([`lib/documents/use-outline-scroll-spy.ts`](../apps/web/src/lib/documents/use-outline-scroll-spy.ts)).
The Index tab
([`DocumentIndexPanel`](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/DocumentIndexPanel.tsx>))
queries `knowledge.document` only while it is visible and polls every 3 s
while a layer is pending or the response predates the version on screen
([`lib/knowledge/documentIndex.ts`](../apps/web/src/lib/knowledge/documentIndex.ts)).

The Tables adapter's `tableFolder.tree` leaves carry `rowCount`, `lastEditedAt`,
and `lastEditedBy` for the explorer's Rows/Last edited/By columns.
`table.importCsv` (Editor+) creates a table from a dropped `.csv`/`.tsv` file:
[`tables/csv.ts`](../packages/core/src/tables/csv.ts) parses delimiter-detected,
quote-aware CSV and infers each column's type in precedence order — number,
datetime, date (strict `YYYY-MM-DD`), boolean, url, longtext, else text —
from its values. BOM-aware UTF-8/UTF-16 decoding falls back to Windows-1252; blank
records are skipped and leading-zero/plus identifiers remain text.
[`services/tableImport.ts`](../packages/core/src/services/tableImport.ts)
(`importCsvTable`) derives the title from the file name and writes through the
same `createTable` tail as the create dialog. `TablesWorkspace` is now only the
detail editor's context-rail shell — the folder/table list lives entirely in
the shared explorer above it.

The grid supports ten column types: text, number, date, datetime, select,
multiselect, boolean, url, longtext, and document. Type-specific editors and
renderers live in
[`TableCellEditors.tsx`](<../apps/web/src/app/(workspace)/projects/[projectId]/tables/_components/TableCellEditors.tsx>)
and are wired into [`grid.ts`](../apps/web/src/lib/tables/grid.ts)'s column
defs: `dateTimeCellEditor` seeds a native `datetime-local` input from the
cell's own instant using the viewer's own local offset (not the cell's stored
zone) and renders the cell in the viewer's local time; `multiselectCellEditor`
is a popup checkbox listbox that
commits on every toggle, in `column.options` order; `url` cells render as a
clickable link guarded by `isValidUrlCell`; `longtext` cells use AG Grid's
large-text editor plus a grid-level Expand dialog rendering the value as
Markdown. See `weaver-tables` for validation caps, retype rules, and
query/aggregate semantics for the new types. Select sorting uses labels, date cells
and filters require `YYYY-MM-DD`, and datetime groups/distinct counts use instants.
Merged saves retain insertion positions and reject incompatible concurrent reorders;
conflict dialogs offer a JSON draft export before reload.

Document details stay directly editable for Editor+ on desktop and phone.
[`DocumentScreen`](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/DocumentScreen.tsx>)
coordinates the document/diff view; [`DocumentEditor`](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/DocumentEditor.tsx>)
keeps one TipTap instance with a shared [`DocumentHeader`](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/DocumentHeader.tsx>).
[`draft-state.ts`](../apps/web/src/lib/documents/draft-state.ts) compares title and
document content with the acknowledged saved baseline;
[`use-document-session.ts`](../apps/web/src/lib/documents/use-document-session.ts)
owns direct save, refresh, discard, and conflict reload/overwrite. Save and Discard
appear for changes; saving retains the canvas and undo history, while confirmed
discard/reload resets history. Pending image uploads use mapped selection bookmarks
and cancellation in [`use-document-images.ts`](../apps/web/src/lib/documents/use-document-images.ts).
For Python documents `DocumentScreen` renders `PythonDocumentEditor`
(CodeMirror 6, [`python-editor.ts`](../apps/web/src/lib/editor/python-editor.ts))
on [`use-text-document-session.ts`](../apps/web/src/lib/documents/use-text-document-session.ts),
with `PythonOutlinePanel` in the Contents tab; PDF export and remote send are
disabled, and the kind icon (`DocumentKindIcon`) marks them in the explorer,
breadcrumbs, pins, search results and citations.
Saved normalization uses [`reconcile-document-content.ts`](../apps/web/src/lib/documents/reconcile-document-content.ts)
to update attributes and changed spans while preserving unrelated undo steps.

[`EditorToolbar`](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/EditorToolbar.tsx>)
provides permanent formatting and insertion controls in the shared page header,
left of Context. `DocumentWorkspaceToolbar` portals those controls from the editor
into the stable header target without moving or recreating the editor. The
command model lives in [`document-toolbar-groups.ts`](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/document-toolbar-groups.ts>)
(Text style, marks, lists and blocks with Callout, contextual Code language/Table
options, Insert, history); [`DocumentToolbarControls`](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/DocumentToolbarControls.tsx>)
renders them in one compact row and moves groups that do not fit into a
"More formatting options" menu, measured by
[`use-toolbar-overflow.ts`](../apps/web/src/lib/editor/use-toolbar-overflow.ts)
(re-measured from the full, More-less row when the groups change or gain room).
Source stays fixed at the right. Callout commands live in
[`callout-commands.ts`](../apps/web/src/lib/editor/callout-commands.ts); callout
colors and labels come from `globals.css` for both editor and reader.
There is no toolbar visibility toggle or shortcut. The Source control and
Ctrl/Cmd+Alt+S switch the body to
[`DocumentSourceView`](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/DocumentSourceView.tsx>),
a bare, auto-growing Markdown textarea in the document body. Editor+ can edit
raw Markdown; Viewers can select/copy it. The title, Save/Discard, and Context
stay available; formatting commands are disabled in raw mode. The toolbar button
or shortcut toggles back to WYSIWYG, with no extra source panel controls.
[`use-document-source-view.ts`](../apps/web/src/lib/editor/use-document-source-view.ts)
keeps both bodies mounted, hides/inerts the inactive one, and restores focus and
scroll on return. New section navigation reveals formatted content once raw input
is valid. [`document-markdown.ts`](../apps/web/src/lib/documents/document-markdown.ts)
bounds and validates raw input through the canonical Markdown codec and schema.
Raw text and parsed content share the draft revision/baseline: typing and toggling
preserve literal input, while saving adopts canonical Markdown and renamed image
paths without moving the focused raw caret. Invalid source remains a dirty draft and cannot be saved or hidden by
switching modes. Discard/reload resets both histories. Pending image uploads
temporarily lock raw typing so completion cannot overwrite a lexical draft.
[`use-document-view-shortcuts.ts`](../apps/web/src/lib/editor/use-document-view-shortcuts.ts)
scopes view shortcuts away from other inputs, dialogs, and composition events.
The source textarea accepts Ctrl/Cmd+S; Escape blurs it without changing modes.
Mermaid source opens locally in
[`MermaidNodeView`](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/MermaidNodeView.tsx>).
Code blocks show a copy button from
[`DocumentCodeBlock.tsx`](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/DocumentCodeBlock.tsx>):
a reader mapping and a client-only editor node view (the `codeBlock` override of
`documentExtensions`) that leave the stored document unchanged.
The static Viewer and editable canvas share reference resolution and navigation
through [`useDocumentPresentation`](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/useDocumentPresentation.ts>);
[`DocumentCrossref`](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/DocumentCrossref.tsx>)
adds resolved document/table previews without changing stored attributes.
[`document-heading-anchors.ts`](../apps/web/src/lib/editor/document-heading-anchors.ts)
supplies both static rendering and the editor's
[`document-section-anchors.ts`](../apps/web/src/lib/editor/document-section-anchors.ts)
decorations, including ephemeral section highlighting. In editable documents,
explicit section navigation scrolls/highlights
the section and focuses the title outside the editable body; saving does not
replay navigation.

The browser's `document.update` omits a manual change comment and calls
[`saveDocumentAndQueueSummary`](../packages/core/src/services/documentChangeSummaries.ts).
The save commits a plain `update: <path>` and, when jobs are enabled and the
optional `document_summary` route is ready, inserts a `pending`
`DocumentChangeSummary` row (keyed by project and commit SHA, no document FK)
and queues `document.change-summary`. Enqueue problems never fail the save;
they emit `document.summary.failed` or `document.summary.retrying` with reason
`enqueue`. The worker reads both Git versions, sends bounded title and
changed-excerpt input with provider bodies suppressed, records usage as
`document.change_summary`, and fences terminal writes on the claimed attempt:
`ready`, `failed` (`timeout`, `provider`, `validation`, `source_missing`,
`abandoned`), or `skipped` (`no_route`, `no_change`) within three attempts.
`system.reconcile` re-queues rows not updated for 15 minutes and abandons rows
older than 24 hours. It also deletes `failed` and `skipped` rows 30 days after
completion (at most 5,000 per pass); `ready` summaries are kept for the life of
the project. Errors that are not a classified `AiProviderError` (such as
a credential or database failure during the provider call) fail the job attempt
(`job.failed`) without a stored reason; once attempts are exhausted the row ends
`failed/abandoned`. Each row also stores `basePathAtSha` (the document path
before the save, so the base read does not depend on git rename detection),
`lastJobId`, and `lastErrorClass` (the safe class of the latest error, cleared
on `ready`); a failed usage write emits `document.summary.usage_failed`.
Explicit API comments are still written into the commit.
History, `content_history`, project activity, and task digests overlay the
row through
[`documentChangeSummaryReads.ts`](../packages/core/src/services/documentChangeSummaryReads.ts);
[`changeSummaryMessage`](../packages/core/src/documents/changeSummaryMessage.ts)
composes the displayed line.

The assistant is a shell-level panel: `AppShell` mounts one
[`AssistantProvider`](../apps/web/src/components/assistant/AssistantProvider.tsx)
(open state, active conversation, the single live-run SSE subscription, an
unseen-completion flag) and renders
[`AssistantPanel`](../apps/web/src/components/assistant/AssistantPanel.tsx) as
a large centered `Dialog` on every viewport size; dismissing it leaves the
shell-owned run subscription active and records unseen completions; `⌘J`/`Ctrl+J` toggles it from the same listener that owns `⌘K`.
`/assistant` and `/assistant/[conversationId]` render the same
[`AssistantConversation`](../apps/web/src/components/assistant/AssistantConversation.tsx)
full-width beside a conversation list. Settled messages render from
`MessageView.text`, `assistant.listCitations`, and `assistant.listProposals`;
only the live run renders from the event stream
([`lib/assistant/runEvents.ts`](../apps/web/src/lib/assistant/runEvents.ts),
[`liveMessage.ts`](../apps/web/src/lib/assistant/liveMessage.ts)). Scope is a
per-message draft ([`scopeDraft.ts`](../apps/web/src/lib/assistant/scopeDraft.ts));
citation cards reuse `documentSectionHref` with a server-computed
`navigationAnchor`; proposal cards accept in one click for Editor+. There is
no sidebar entry for the assistant.

The conversation header carries New/Conversations buttons, the window a
remembered full-screen toggle, and the controls row a session bar
([`SessionUsage.tsx`](../apps/web/src/components/assistant/SessionUsage.tsx))
fed by `assistant.getConversationUsage`
([`assistantUsage.ts`](../packages/core/src/services/assistantUsage.ts); migration
`20261003130000_ai_usage_run_index`). Scope has a `folder` kind, an advisory
focus resolved in [`scope.ts`](../packages/core/src/assistant/scope.ts).

The conversation's `Auto-approve` checkbox
([`AutoApproveChanges.tsx`](../apps/web/src/components/assistant/AutoApproveChanges.tsx))
persists `AssistantConversation.autoApproveChanges` through
`assistant.setAutoApproveChanges`, defaulting off. New native document/table
proposals use the existing acceptance path on the worker, including while the
dialog is closed; existing pending proposals are unaffected. The same flag
lets write tools of the owner's MCP connections run without an approval. Admission rechecks the current attempt, setting, permissions and
revision. Turning it off prevents subsequent admissions; already claimed writes
finish. Accepted/interrupted acceptances suppress automatic run retries and stay
visible with recovery actions after failure or cancellation.

The visual language follows the Weaver design kit (v1.1 "Blue"): its
cool-white surfaces, cobalt accent, radii and shadows fill the existing tokens in
[`globals.css`](../apps/web/src/styles/globals.css) (Weaver's compact type
scale and panel sizes stay), Hanken Grotesk and JetBrains Mono are self-hosted
through the `@fontsource-variable` packages imported by the root layout (the
CSP allows only same-origin fonts), and
[`LogoMark`](../apps/web/src/components/brand/LogoMark.tsx) draws the W mark
before the product name. Sign-in and consent share
[`(auth)/layout.tsx`](<../apps/web/src/app/(auth)/layout.tsx>): the
paper-and-thread artwork behind a card, pinned to the light tokens by
`.theme-light` in both themes. The project switcher sits at the top of the
sidebar (an icon button in the collapsed rail); breadcrumbs on project routes
start with a link to the project. The sidebar is navy in both themes: its
`<aside>` carries `.nav-scope`, which re-points the generic tokens for that
subtree, so sidebar children keep the ordinary token classes.

The primary sidebar
([`Sidebar.tsx`](<../apps/web/src/app/(workspace)/_components/Sidebar.tsx>))
collapses into a `--sidebar-w-collapsed` icon rail of `RailLink`s. The account
menu lives only in the top bar; the sidebar ends with the build stamp. The choice
lives in the `weaver-sidebar` cookie
([`lib/sidebar-state.ts`](../apps/web/src/lib/sidebar-state.ts)); the
`(workspace)` layout reads it server-side and passes it to `AppShell` so the
first paint already matches.
The expanded sidebar and the document/table Context rails are resizable by
dragging a
[`PanelResizeHandle`](../apps/web/src/components/layout/PanelResizeHandle.tsx)
(arrow keys step 16px, double-click resets). Widths, ranges, and the
`weaver-sidebar-width`/`weaver-context-rail-width` cookies (base-path scoped)
live in [`lib/panel-widths.ts`](../apps/web/src/lib/panel-widths.ts); the
layout reads them server-side, `AppShell` sets `--sidebar-w-pref` and
`--context-rail-w-pref` on `[data-app-shell]`, and `globals.css` derives
`--sidebar-w`/`--context-rail-w` from them, capped by the window width. A drag
only previews the variable and saves the cookie on release.
Below `md`, [`MobileNavigation.tsx`](<../apps/web/src/app/(workspace)/_components/MobileNavigation.tsx>)
uses the same sidebar in a modal drawer; route changes and desktop resizing close
it without overwriting the desktop cookie. The top bar uses compact controls and
contained breadcrumbs on narrow screens.

The sidebar is project-scoped and lists the active project's sections in the
order Documents, Tables, Graph, Imports (Editor+), Tasks, Activity, Settings
([`ProjectSections.tsx`](<../apps/web/src/app/(workspace)/_components/ProjectSections.tsx>)).
On routes without a project segment (Administration, Account, Assistant) the
sections, switcher label and breadcrumbs use the stored last-opened project
through [`use-active-project-id.ts`](../apps/web/src/lib/navigation/use-active-project-id.ts),
so the open project never disappears. There is no Home page: `/`, `/home` and
`/projects/<id>` redirect to the landing project's Documents
([`services/landingProject.ts`](../packages/core/src/services/landingProject.ts),
backed by `User.lastOpenedProjectId`, kept current by
[`LastOpenedProjectRecorder.tsx`](<../apps/web/src/app/(workspace)/_components/LastOpenedProjectRecorder.tsx>)).
Every user owns a personal workspace, an ordinary project marked by
`Project.personalOwnerId` ([`personalWorkspace.ts`](../packages/core/src/services/personalWorkspace.ts),
migration `20260922000700`), created when an Admin creates the account and on
first landing for existing users; it cannot be deleted and its owner keeps the
Owner role. It is the landing fallback for users without other memberships.
Documents breadcrumb trails come from
[`DocumentsBreadcrumbs.tsx`](<../apps/web/src/app/(workspace)/_components/DocumentsBreadcrumbs.tsx>),
whose folder crumbs each open a sibling menu of that folder's contents.

### Document review

Every document carries reviewers, a review interval and its last review in the
header, mirrored into `Document` review columns and `DocumentReviewer` rows
(migration `20261007090000_document_review`; the new models `ReviewerGroup`,
`ReviewerGroupMember`, `ProjectDefaultReviewer`, `DocumentReviewer` and
`Project.defaultReviewEveryMonths` are in the schema).

- Pure rules (`reviewDueAt`: due at `since` until the first review, then one
  interval after `lastReviewed`; limits, canonical reviewer order):
  [`documents/review.ts`](../packages/core/src/documents/review.ts); header
  compose/parse in [`frontmatter.ts`](../packages/core/src/documents/frontmatter.ts).
- Marking reviewed, review settings, the due list, the recently reviewed list
  (projection columns only; `20261008100000_document_last_reviewed_index`) and the effective-reviewer
  rule: [`services/documentReview.ts`](../packages/core/src/services/documentReview.ts).
  Groups, project defaults, create/import defaults:
  [`services/reviewerGroups.ts`](../packages/core/src/services/reviewerGroups.ts).
  [`services/folderReview.ts`](../packages/core/src/services/folderReview.ts)
  resolves the nearest document-folder/root default at the writer's locked
  HEAD; creation through UI, assistant/MCP, ingestion and remote imports shares
  this resolver. Stored targets resolve against current membership/groups;
  explicit empty or ineffective settings use Owners and the project interval.
  Plain Markdown/ZIP imports carry raw `reviewSource` into the writer, retaining
  usable source reviewers/interval while restarting the import clock. ZIP
  Replace, content saves and moves retain existing review metadata; deleted
  recovery retains its review block or resolves destination defaults at recovery time.
  Membership joins/leaves keep reviewer links current
  ([`services/projectReviewerLinks.ts`](../packages/core/src/services/projectReviewerLinks.ts));
  imports keep only a file's known reviewers and interval and start the clock
  at import (`resolveImportedReview`); due dates are projected from dates
  clamped to now, which covers blocks arriving by a Git remote pull. `Document` has a composite
  `(projectId, reviewDueAt, id)` index (`20261007090100_document_review_due_index`).
  The forward migration
  [`20261008110000_review_due_future_clamp`](../packages/db/prisma/migrations/20261008110000_review_due_future_clamp/migration.sql)
  repairs future due dates left by the never-reviewed backfill, using UTC and
  preserving reviews that are already due.
  Review writes are metadata-only commits; the upgrade pass adds blocks to existing
  documents ([`documentHeaderUpgrade.ts`](../packages/core/src/services/documentHeaderUpgrade.ts)).
- Folder defaults and recursive assignment:
  [`documents/folderReview.ts`](../packages/core/src/documents/folderReview.ts)
  owns canonical references, whole-segment inheritance and batch limits;
  [`folderMetadata.ts`](../packages/core/src/documents/folderMetadata.ts) stores
  optional `reviewDefaults.reviewers` in document-folder `.folder.json` and a
  separate nameless document-root file. Missing settings inherit through the
  nearest ancestor/root to project defaults; explicit `[]` stops inheritance
  and uses Owners. Defaults survive folder rename/move and stamp backfill.
  [`services/folderReview.ts`](../packages/core/src/services/folderReview.ts)
  owns reads, shared preview/apply planning, guarded recursive assignment and
  clearing. Owners/Maintainers apply against an explicit project HEAD under one
  writer lock, revalidating current targets and raw stored defaults. Git inventory
  includes documents missing from the projection. One commit replaces document
  reviewers, sets the selected default and removes descendant overrides; unchanged
  files are skipped. More than 1,000 document rewrites or 50 MiB of rewritten
  UTF-8 document bytes is rejected before mutation. Preview and apply also reject
  any composed document exceeding 2,000,000 UTF-8 bytes, naming the affected path;
  the shared `documents.assertDocumentFileSize` guard also protects ordinary
  document writes and `documentReview.writeReview`. Intervals, clocks/history,
  content, authorship and appearance are preserved. Failed uncommitted writes
  restore originals; accepted Git commits retain the existing projection-repair
  path through `projectPreparedDocumentInRepo` and
  `reportProjectionFailureAndReconcile` in
  [`documents.ts`](../packages/core/src/services/documents.ts). Review-only
  assignments notify content changes without AI summaries. Clear removes only
  the selected default and leaves existing documents unchanged.
- API: [`routers/review.ts`](../apps/web/src/server/api/routers/review.ts),
  [`routers/reviewerGroup.ts`](../apps/web/src/server/api/routers/reviewerGroup.ts),
  and `document.markReviewed`/`setReview`/`reviewPermissions` in
  [`routers/document.ts`](../apps/web/src/server/api/routers/document.ts). The
  read tools shared by MCP and the assistant return the review fields; no write tools.
  Folder `reviewDefaults`/`previewReview`/`setReviewRecursively`/`clearReviewDefault`
  and `previewMarkReviewed`/`markReviewedRecursively` procedures live in [`routers/folder.ts`](../apps/web/src/server/api/routers/folder.ts),
  with [`schemas/folder.ts`](../apps/web/src/server/api/schemas/folder.ts).
  Reads expose configured references separately from effective reviewers and
  inheritance source, keeping explicit empty selections intact.
- UI: the document header review line, Mark as reviewed and Review settings
  (`documents/_components/{DocumentReviewLine,DocumentActionsMenu,MarkReviewedDialog,ReviewSettingsDialog}.tsx`),
  the project settings "Document review" card
  (`settings/_components/DocumentReviewCard.tsx`), and the `/reviews` (Open) and `/reviews/recent`
  (Recently reviewed) pages with the sidebar "Reviews" section ([`reviews/`](<../apps/web/src/app/(workspace)/reviews/>)).
  [`invalidateDocumentReview`](../apps/web/src/lib/documents/review-cache-invalidation.ts)
  refreshes both review lists after review writes.
  Folder menus and document-root actions use
  [`FolderReviewDialog.tsx`](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/FolderReviewDialog.tsx>).
  A fresh preview for each selection supplies Apply's HEAD; permission changes
  disable writes, and stale writes preserve the draft for explicit retry.
  [`invalidateFolderReview`](../apps/web/src/lib/documents/review-cache-invalidation.ts)
  refreshes folder defaults, document reads and review lists/counts while retaining
  dirty editor baselines for normal revision conflicts. After an accepted write
  with failed refresh, recovery retries caches with further writes disabled.
- Known follow-up: a Git remote pull keeps a local review-only change and a
  remote edit of the same document as two documents; carrying the local review
  block onto the remote text is not done yet.
- The spec's documents explorer "Review due" column is not implemented: the
  explorer has no optional-column mechanism. Instead `folder.tree` returns
  `reviewDueAt`/`lastReviewedAt` per document and
  [`ReviewStatusIcon`](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/ReviewStatusIcon.tsx>)
  shows reviewed / due soon / overdue beside the index lights, using
  [`documentReviewStatus`](../apps/web/src/lib/documents/review-status.ts).

## Knowledge jobs

[`packages/core/src/jobs/publisher.ts`](../packages/core/src/jobs/publisher.ts)
owns durable publication from web writes with a send-only pg-boss instance (no
supervision, scheduling, or enrichment migration). Queue payloads contain
canonical IDs, Git SHAs/paths, generation IDs, and configuration fingerprints
only. The agent worker owns handler registration and scheduled reconciliation
through
[`packages/core/src/jobs/runtime.ts`](../packages/core/src/jobs/runtime.ts);
both sides construct their queue via
[`packages/core/src/jobs/knowledgeQueue.ts`](../packages/core/src/jobs/knowledgeQueue.ts),
and the running worker registers its queue as the process publisher before polling
starts. Follow-up enqueues reuse it instead of starting a second instance. Shared
validated settings live in [`@weaver/config/jobs`](../packages/config/src/jobs.ts).
System reconciliation settles project work, diagnostics pruning, storage cleanup,
and ingestion recovery independently before reporting any failures. Document change
summaries (`document.change-summary`) run on knowledge workers with a short-policy
queue, two pg-boss retries, and reconcile recovery. Project passes receive the
worker abort signal. System reconciliation has a 60-minute lease. Workers share
`WEAVER_ENABLED_WORKER_ROLES`, the deployment-wide enabled union: local assignments
must be a subset, and only globally disabled assistant/task/Git roles lose their
cron schedules, so split workers preserve each other's schedules.

Enrichment claims persist a token and pg-boss delivery identity. Newer retries
replace the token; embedding, graph, and terminal-state writes fence stale owners.
Cancellation releases its own claim immediately. A configuration-blocked shadow
generation ends failed while preserving the active generation. Keyword sync copies
unchanged vectors before removing obsolete chunk ownership. For byte-identical
moved documents, [`knowledgeMoves.ts`](../packages/core/src/services/knowledgeMoves.ts)
carries complete compatible AI state and live evidence to the new SHA/chunk IDs
without provider calls. Reconciliation waits for keyword sync before resetting
AI targets; changed files and incomplete indexes retain normal processing. Entity descriptions
derive from current source mentions through
[`knowledgeEntityDescriptions.ts`](../packages/core/src/services/knowledgeEntityDescriptions.ts);
changed descriptions invalidate their entity embeddings. Candidate scans filter
normalized types before bounding aliases and treat overflow as incomplete evidence.
Resolution retries cache staged vectors by content hash; repeated identity races
remain retryable internal failures. Description drift does not change the identity
signature; publication skips outdated vectors and repairs them after releasing the
processing claim. Terminal failures invalidate older-SHA graph provenance and
refresh descriptions. Graph details label model excerpts as generated summaries.

Keyword indexing remains available without AI: every document, folder, and
table write enqueues its search-sync job after the Git commit, and
`DocumentSearchChunk.searchVector` is generated from the chunk's heading path
(document title and headings) plus its body.
[`chunkDocument.ts`](../packages/core/src/knowledge/chunkDocument.ts) picks the
chunker by document kind: Markdown splits at headings, Python
([`chunkPython.ts`](../packages/core/src/knowledge/chunkPython.ts)) at top-level
`def`/`class` groups (heading path `[title, "def name"]`); the assistant's
outline and patch section ids follow the same kind
(`documentOutlineFor`, `python:<kind>:<name>:<ordinal>`). AI is enabled by assigning the
`knowledge_extraction` and `knowledge_embedding` routes in Administration ›
AI. The worker resolves routes per job through
[`packages/core/src/ai/registry.ts`](../packages/core/src/ai/registry.ts) (15 s
cache), re-resolves uncached before blocking a job on a fingerprint mismatch,
decrypts credentials per outbound request only when the live endpoint, provider,
and enabled state match the retained adapter, and snapshots the route on each
generation. The route snapshot includes the embedding dimension mode,
`KnowledgeGeneration.embeddingDimensions` stores the configured target, and
the knowledge configuration fingerprint includes both, so changing either
requires a matching generation. The size comes from the routed embedding model
and may be any integer from 1 to 4,000
([`dimensions.ts`](../packages/core/src/knowledge/dimensions.ts)); semantic SQL
casts through [`embeddingVectorType`](../packages/core/src/knowledge/vectorSql.ts)
(`vector(n)` up to 2,000, `halfvec(n)` above), and migration
[`20260926120000_knowledge_embedding_dimensions`](../packages/db/prisma/migrations/20260926120000_knowledge_embedding_dimensions/migration.sql)
indexes 256–4,000 common sizes while other sizes use exact search. A routed
embedding model edit, or an embedding route switch, that would replace the
live knowledge routing's index identity first embeds one sample
(`probeKnowledgeEmbedding`) and fails with a field error when the size does
not come back. A new generation that replaces an active one with the same
extraction schema version copies its graph and graph-ready document states
([`knowledgeCarryForward.ts`](../packages/core/src/services/knowledgeCarryForward.ts),
recorded in `KnowledgeGeneration.graphSourceGenerationId`), except when it supersedes a building generation that was re-extracting; carried documents
only embed chunks and their entities. Embedding batches are capped against the exact
serialized 128 KiB provider request body for both document and entity embeddings
through [`embeddingBatches.ts`](../packages/core/src/ai/embeddingBatches.ts),
which lazily applies the knowledge provider's
[`embeddingPacer.ts`](../packages/core/src/ai/embeddingPacer.ts) character
budget: one input until measured, then half the embedding connection's timeout at
the averaged throughput (halved after a timeout). Connection timeouts allow up to
120 s; the enrichment lease stays at pg-boss's 24-hour maximum and a 23-hour
deadline aborts provider calls with a retryable failure. Each embedded document
emits `knowledge.document.embedded` request statistics. A rejected extraction
response gets one correction turn
([`extractWithCorrection`](../packages/core/src/ai/http.ts)): the adapter replays
the response with its validation issues and parses the corrected answer, logging
`knowledge.extraction.corrected`. Search bounds the query
embedding at five seconds before reporting keyword fallback and a
`knowledge.search.degraded` warning.
Reconciliation repairs generation source targets and attempts completed-building
activation independently of a compatible active generation. A fresh matching route
reopens configuration-blocked active documents automatically. Deleted-document
`missing` tombstones no longer enqueue cleanup; deletion deliveries share a
source-type/ID/SHA singleton. Ready-document redelivery also retries activation. Graph extraction sends
[`EXTRACTION_SYSTEM_MESSAGE`](../packages/core/src/ai/http.ts), which spells
out every field of extraction schema version 1 (a unit test keeps it in sync
with `extractionResponseSchema`); `KNOWLEDGE_PROMPT_VERSION` feeds the
per-document extraction fingerprint, so a prompt wording change still bumps
it (surfacing as a stale `outdatedExtraction` count), but it never creates a
generation or forces a rebuild. Adapters:
[`packages/core/src/ai/adapters.ts`](../packages/core/src/ai/adapters.ts)
(OpenAI, OpenAI-compatible, Anthropic, LM Studio, and Ollama) share
[`finalizeEmbeddingVector`](../packages/core/src/ai/embeddingDimensions.ts):
native vectors must already have the declared size, while Matryoshka vectors
may be reduced to their leading declared dimensions and are L2-normalized
before knowledge services receive them. The `dimensions` transport is
provider-specific: Ollama sends it for Matryoshka models, OpenAI only sends it
for `text-embedding-3` models, and LM Studio or generic OpenAI-compatible
providers rely on the shared finalization path when they return native-size
vectors. Search/graph reads use only active
generations, and semantic search selects active generations whose
`configFingerprint` (the index fingerprint) equals the live one; the
extraction route and prompt version sit outside that fingerprint, so an
extraction-only change never invalidates active semantic results. Chunk-vector
reuse across generations matches the same `configFingerprint` plus content
hash in [`knowledgeEmbeddings.ts`](../packages/core/src/services/knowledgeEmbeddings.ts),
with no provider/endpoint/model-name comparison. Semantic queries use transaction-local HNSW
iterative scanning with strict ordering and `ef_search=100`. Lexical ranking and
window functions use bounded live candidates before ranking, retaining separate
exact-title/name/alias paths. Exact-title document search uses `DocumentIndexState.exactProjectId`
as its generated ready/current eligibility gate and an ordered covering index
for collision-safe, bounded per-project scans. Rebuilds publish a shadow
generation atomically. Maintainer operations remain bounded and cursor-driven. See the
[`weaver-knowledge-graph` skill](../.claude/skills/weaver-knowledge-graph/SKILL.md)
for invariants and verification.

The index fingerprint (`KnowledgeGeneration.configFingerprint`) and the per-document
extraction fingerprint are separate identities, computed by
[`identity.ts`](../packages/core/src/knowledge/identity.ts):
`knowledgeIndexFingerprint` covers only the embedding model's effective vector-space
key, dimensions, dimension mode, and extraction schema version, while
`knowledgeExtractionFingerprint` covers the extraction route and prompt version and
is stored per document (`KnowledgeGenerationDocument.extractionFingerprint` /
`extractionModel`). Switching the extraction model or bumping the prompt version
never creates a generation; it only makes existing documents' stored fingerprint
stale, which `knowledge.status` reports as `outdatedExtraction` and Rebuild
re-extracts. SQL twins of both functions live in migration
[`20260926090000_knowledge_index_identity`](../packages/db/prisma/migrations/20260926090000_knowledge_index_identity/migration.sql).
Admin saves that change routing, models, or connections run through
[`withKnowledgeRoutingChange`](../packages/core/src/services/knowledgeRoutingChange.ts),
which queues `project.reconcile` for every live project when the index
fingerprint changes and records who changed it and when.

Two reads describe the index. `knowledge.status` (Maintainer+) returns each
active/building generation's `embedding` — model, dimensions, dimension mode from
the route snapshot, and `vector`/`halfvec` column type — built by
[`generationEmbedding.ts`](../packages/core/src/knowledge/generationEmbedding.ts),
which the project settings card renders. `knowledge.document` (Viewer+,
[`knowledgeDocument.ts`](../packages/core/src/services/knowledgeDocument.ts))
returns one document's index lights, keyword state and current-SHA chunk count,
each active/building generation's embedding plus its `KnowledgeGenerationDocument`
row and embedded-chunk count, whether the graph came from an outdated extraction,
and the active generation's entity/relation counts with its 50 most-mentioned
entities. Model names (embedding and extraction) are filled in for Maintainer+
only.

[`knowledgeTargets.ts`](../packages/core/src/services/knowledgeTargets.ts) shares
locked generation/source checks with `Project FOR NO KEY UPDATE`, which serializes
knowledge writers without blocking unrelated child inserts; [`knowledgeCalls.ts`](../packages/core/src/ai/knowledgeCalls.ts)
shares cancellation, usage, and vector validation. The
[`knowledge lookup indexes`](../packages/db/prisma/migrations/20260914000100_knowledge_lookup_indexes/migration.sql)
cover embedding reuse and entity/alias trigram lookup. The
[`graph lexical vectors`](../packages/db/prisma/migrations/20260922211200_graph_lexical_search_vectors/migration.sql)
add stored generated entity/alias tsvectors and GIN indexes; the
[`index replacement cleanup`](../packages/db/prisma/migrations/20260922211300_remove_replaced_graph_search_indexes/migration.sql)
removes their superseded expression indexes.
Rebuilds supersede obsolete building generations and terminate unrecoverable work;
missing AI routes do not create doomed shadow generations. Extraction keeps separate
per-response and aggregate document caps, merges convergent entity identities, and
removes entities without active provenance. Job definitions update existing queue
options and collapse repeat generation/document deliveries; enrichment reuses a
current keyword projection. Embedding reuse and nearest-neighbor reads are batched
and indexed. The lease budget is derived from bounded provider work.

## Scheduled tasks

Publication stores completion metadata before the Git write and output identity
afterward. Missing acknowledgements can be recovered only from a unique trusted
local Git commit with the exact operation and run IDs;
`expireAbandonedRuns` acknowledges published receipts instead of classifying them as
provider failures. Acknowledgement is idempotent and retries never regenerate content.
The task-row lock also prevents scheduled ticks adding queued/running overlap.

`ScheduledTask` and `ScheduledTaskRun` (`packages/db/prisma/schema.prisma`)
hold one owner + scope + output-project task and its run history. A succeeded
run keeps its own `outputProjectId`, `outputDocumentId` and `outputCommitSha`, so
history links survive a later change of the task's output project; the document
page accepts `?version=<sha>` to open a comparison against a saved version.
A task's output target is `outputDocumentId` (an existing document or one the
task creates under `outputTitle` in `outputFolderPath`) with `outputMode`
`replace` or `update` (migration `20261003150000_scheduled_task_output_target`);
the create/edit dialog is tabbed (General, Instructions, Focus, Tools, Output).
[`packages/core/src/services/scheduledTasks.ts`](../packages/core/src/services/scheduledTasks.ts)
is the policy owner: CRUD, pause/resume/run-now, the §5 owner/project limits,
and the per-task `SELECT … FOR UPDATE` lease/skip/fail/succeed transitions
(five consecutive failures pause the task). Schedules are presets plus an
IANA timezone, resolved to cron and next-occurrence by
[`scheduledTasks/{scheduleSchema,schedule}.ts`](../packages/core/src/scheduledTasks/scheduleSchema.ts)
(`cron-parser` with an explicit `tz`). The minute tick,
[`scheduledTasks/tick.ts`](../packages/core/src/scheduledTasks/tick.ts),
claims due tasks with a conditional `nextRunAt` update so two workers never
claim the same slot, re-dispatches stale-queued runs, and expires abandoned
leases.
[`scheduledTasks/context.ts`](../packages/core/src/scheduledTasks/context.ts)
assembles a run's prompt: a change digest since the task's last successful
`projectHeads`, from
[`services/projectActivity.ts`](../packages/core/src/services/projectActivity.ts)
(falling back to a seven-day window), plus scope content, both cut to the
routed model's context window. Paused tasks reject Run now and queued leases
skip with `task_paused`; resume before running manually. Only the owner receives
instruction, source scope, external arguments, error text and context summaries;
output-project Maintainers retain the explicit management/execution grant.
Publication-time permission loss maps to `OUTPUT_FORBIDDEN`.

Required external inputs are saved transactionally with task definitions and loaded
in position order with immutable IDs. [`scheduledTasks/externalInputs.ts`](../packages/core/src/scheduledTasks/externalInputs.ts)
resolves top-level literal/period bindings and fetches the owner's own enabled read tools
sequentially through
once-only dispatch, with live owner flags and source/output memberships. Half
the input byte budget is reserved equally across required inputs including framing;
UTF-8 truncation stays visible. External JSON escapes angle brackets before
framing/budgeting so values cannot close the untrusted delimiter. Attempted input summaries and the fixed UTC period
persist in `contextSummary`, including failures. Provider bodies are suppressed
before external/model work; one tool-free completion reserves escaped provenance
and rechecks live input/output authority before publication. External-input edits
and deletion reject queued/running tasks; no-input behavior stays unchanged.
Migration `20260921000600_external_task_input_identity` adds immutable call
`inputSnapshotId` and a nullable live input FK, preserving duplicate identity after
completed inputs are removed.

Project and Account task editors share
[`ExternalInputsEditor.tsx`](<../apps/web/src/app/(workspace)/projects/[projectId]/tasks/_components/ExternalInputsEditor.tsx>)
through `TaskDialog`: source/output availability intersection, ordered named inputs,
JSON arguments and explicit period bindings. Saved unavailable inputs remain visible
for repair/removal; empty-input tasks do not depend on MCP availability. The detail
shows a read-only definition list and `RunHistoryTable` renders bounded, validated
metadata through [`lib/tasks/externalInputs.ts`](../apps/web/src/lib/tasks/externalInputs.ts),
never raw external results or arbitrary failure text.

A run executes through
[`packages/ai/src/taskRunner.ts`](../packages/ai/src/taskRunner.ts)
(`createScheduledTaskRunner`, `@weaver/ai/taskRunner`) rather than
`packages/core`, because core never imports the AI SDK layer; `apps/agent-worker`
injects it as `taskRunner`, like `assistantRunner`. The runner reads the
owner's `banned`/`mustChangePassword` flags live (never on the bearer path)
and skips the run if either is set, then acts through
`createTaskSecurityContext` (`packages/core/src/security/context.ts`):
`content:read`/`content:write` only, never assistant, propose, or admin
capabilities. One `generateText` call against the `jobs` route ("Scheduled
tasks" in Administration › Settings › AI) produces the whole document. The `tasks`
worker role (`packages/config/src/workerRoles.ts`) gates both `task.tick`
(scheduled by `WEAVER_TASK_TICK_CRON`) and `task.run`. Project › Tasks
(`/projects/[projectId]/tasks`) and Account › Tasks (`/account/tasks`) list
and manage tasks; a maintained document carries a banner. See the
[`weaver-scheduled-tasks` skill](../.claude/skills/weaver-scheduled-tasks/SKILL.md)
for conventions and testing.

[`completion.ts`](../packages/ai/src/completion.ts) rejects incomplete model
finishes before task output or its change baseline can advance. Import OCR applies
the same finish check while allowing completed blank pages; optional import analysis
falls back to parsed metadata. Ingestion and task accounting failures emit separate
diagnostics without changing a successful provider result.

## Exams

`listExams` returns `{ items, nextCursor }`, ordered by updated time and ID, with
bounded pages and grouped question/attempt aggregates. `loadExamDefinitionInTx`
provides attempt starts with a question snapshot without history counters; the
trainer UI and `list_exams` tool preserve server continuation cursors.

Project training roles are orthogonal to content roles, defaulting to Off.
[`projectTraining.ts`](../packages/core/src/services/projectTraining.ts) owns
membership-serialized role changes and membership-removal cleanup; project metadata
mirrors roles without storing exam content in Git.

[`exams.ts`](../packages/core/src/services/exams.ts) owns PostgreSQL definitions
and lifecycle; [`examAttempts.ts`](../packages/core/src/services/examAttempts.ts)
owns immutable attempt snapshots (choices shuffled once at start), server deadlines, sequence-ordered answer saves,
submission and revision-guarded grade proposals and release. The browser-safe
[`exams/schema.ts`](../packages/core/src/exams/schema.ts) supplies validation,
partial-credit scoring and the answer-safe trainee projection. All services intersect membership,
capability and training role. Trainee actions and trainer release require sessions;
agent proposals wait for trainer review.

The [`exam` router](../apps/web/src/server/api/routers/exam.ts) serves project
Exams lists, the definition editor and taking/review/result screens. The editor
mounts nested choice fields only for multiple-choice questions and remounts them
after question reordering to preserve valid free-text payloads.
[`ExamTextarea`](<../apps/web/src/app/(workspace)/projects/[projectId]/exams/_components/ExamTextarea.tsx>) sizes editor text fields to their contents and width so only the page scrolls.
The trainee attempt screen fetches current answers before mounting its local
autosave form on each visit, preserving that draft across later refreshes.
`exams/results` owns the trainee's completed-attempt table and the trainer's
cursor-paged ongoing, submitted, review and released-result tables, with explicit row
actions. [`DeleteAttemptButton`](<../apps/web/src/app/(workspace)/projects/[projectId]/exams/_components/DeleteAttemptButton.tsx>) confirms deletion from results and the trainee's ongoing-attempt card.
`exam.deleteAttempt` delegates to the session-only `deleteAttempt` service: trainers
can delete project attempts; trainees can delete their own. The service locks the
exam then the attempt and cascades answer deletion. New starts use the highest
remaining attempt number rather than the count. [`ExamQuestionPrompt`](<../apps/web/src/app/(workspace)/projects/[projectId]/exams/_components/ExamQuestionPrompt.tsx>) renders fenced code examples through read-only dialogs across preview, taking, grading and results. Creation guidance keeps all examples in the public question prompt, with solutions in Expected answer.
[`exam.tick`](../packages/core/src/exams/tick.ts) expires abandoned attempts every
minute under the tasks worker role. The personal
[`examSource.ts`](../packages/core/src/services/backgroundWork/examSource.ts)
exposes work and released grades only while the caller is a current trainee.

Seven [`exam tools`](../packages/assistant-tools/src/tools/exams/read.ts) form
`EXAM_TOOLS` and the opt-in MCP `exams` toolset. Trainer assistant runs append
`ASSISTANT_EXAM_TOOLS` dynamically, charging their actual schema bytes: the four
reads, `grade_exam_attempt`, and
[`propose_exam_create`/`propose_exam_update`](../packages/assistant-tools/src/tools/exams/propose.ts)
instead of the direct definition writes. Those store `exam.create`/`exam.update`
assistant proposals ([`examProposals.ts`](../packages/core/src/services/examProposals.ts):
separate from the Git `contentOperationSchema`, text-diff previews, trainer
checks at proposal and acceptance). Acceptance claims, writes and resolves in one
database transaction, so exam proposals never sit in `accepting`; auto-approve
applies them like document and table proposals. Static assistant and MCP core
lists stay unchanged. MCP direct writes use transactional
[`examOperations.ts`](../packages/core/src/services/examOperations.ts) receipts,
pruned after 30 days by failure-isolated housekeeping. No agent tool can release.
See the
[exam skill](../.claude/skills/weaver-exams/SKILL.md).

## Background-work visibility (Phase 6B)

Import and notebook sources apply the active-or-recent predicate before the
materialized union. Task failure text is owner-only. Knowledge `missing` tombstones
contribute neither live progress nor failures.

[`backgroundWork.ts`](../packages/core/src/services/backgroundWork.ts) is a session-only,
permission-aware read model over task runs, ingestion files, owned assistant runs,
knowledge generations and OneNote notebook preparation. Its [source adapters](../packages/core/src/services/backgroundWork/queries.ts)
apply live membership before pagination, counts and receipt insertion. My work is
personal; Project work requires Maintainer for shared operations. Assistant scope
checks cover every source project and never expose another user's conversations.
The thin [`backgroundWork` router](../apps/web/src/server/api/routers/backgroundWork.ts)
provides `list`, `summary` and `markSeen`; browser-safe contracts live in
[`jobs/backgroundWorkSchema.ts`](../packages/core/src/jobs/backgroundWorkSchema.ts).
Each work item carries `errorMessage: string | null` (bounded to 500 characters,
counted by code point, never UTF-16 code units) sourced from its own row —
`ScheduledTaskRun.errorMessage`, `AssistantRun.errorMessage` (owner-only),
`IngestionFile.failureMessage`, or `KnowledgeGeneration.failureSummary` — and
rendered with a two-line clamp (full text in the `title` attribute) in the
background-work row, tray, and Account › Background work table.

`BackgroundWorkReceipt` stores exact per-user completion revisions, with a cascading
User relation and a 14-day retention period. Successful import review transitions
keep the same completion identity. `system.reconcile` prunes at most 5,000 receipts
per pass, independently of other housekeeping. The receipt and read-index migrations
are `20260919000000`, `20260919000100` and `20260919000200`. Lists use signed,
principal/filter-bound keyset cursors, a frozen database UTC observation time, and
a seven-day completed-result window; active work is included regardless of age.

A knowledge generation records `buildTrigger` (`initial | embedding_change |
index_upgrade | manual_rebuild`) and `requestedById`. `requestKnowledgeRebuild`
(project settings Rebuild) sets `manual_rebuild` and the requesting actor.
`ensureGenerationForCurrentConfig` attributes a new generation to the admin
whose [`knowledge.lastRoutingChange`](../packages/core/src/services/knowledgeRoutingChange.ts)
record (written whenever an admin save changes the live index fingerprint to
a new non-null value, including clear-then-set and disable-then-re-enable)
names the same fingerprint within 24 hours as
`embedding_change`; otherwise it is `index_upgrade` with no requester, or
`initial` when the project had no active generation. A generation with a
`requestedById` is a personal row for that user in the `mine` audience whose
state follows the build's own status only (`running`/`succeeded`/`blocked`/
`failed`/`cancelled`), independent of later document-level activity on the
same generation, and whose revision is fixed at the build's terminal
timestamp. [`knowledgeSource.ts`](../packages/core/src/services/backgroundWork/knowledgeSource.ts)
titles rows by trigger — "Knowledge index rebuild: embedding model changed" /
"…: requested" / "…: Weaver upgrade" — and titles a Project-work row for an
active generation with pending/processing documents "Knowledge index:
updating N documents" instead.

[`notebookSource.ts`](../packages/core/src/services/backgroundWork/notebookSource.ts)
lists current-digest, current-parser `ArtifactNotebook` rows (kind `notebook`,
migrations `20260928100000`/`20260928100100`) as "OneNote notebook: <file>". The
row belongs to `requestedById` (the uploader, renamer or retrying reader; null for
reconcile re-queues) and is Project work for Maintainers. `ready` maps to
`succeeded`; failures carry the fixed text of `NOTEBOOK_ERROR_MESSAGES`
(`notebookSchema.ts`). The destination opens the Files page at `?file=`.

[`gitSyncSource.ts`](../packages/core/src/services/backgroundWork/gitSyncSource.ts)
lists a project's Git remote only while its sync is failing (kind `git_sync`,
migration `20261006090000`): an enabled remote with a push error code, or any
remote with a pull error code, as "Git push failed" / "Git pull failed". The
row is personal for every Owner and Maintainer of the project, so the bell
counts it as unseen; Editors and Viewers do not see it. The message is the
project-member copy in
[`gitRemoteMessages.ts`](../packages/core/src/documents/gitRemoteMessages.ts),
shared with the Git remote settings card. The revision hashes the error codes
with the last successful push and pull times: retries of one incident stay
acknowledged, a later incident is unseen again. The destination is the
project's Settings page.

The shell-owned [`BackgroundWorkProvider`](../apps/web/src/components/background-work/BackgroundWorkProvider.tsx)
drives the bell and dialog tray. It polls at 15 seconds idle or 5 seconds while active/open,
pauses when hidden, and acknowledges only displayed personal results.
[`BackgroundWorkTray`](../apps/web/src/components/background-work/BackgroundWorkTray.tsx)
uses a wider, non-scrolling dialog with active/recent selectors and one item per
page; only the displayed recent item is acknowledged. Account ›
[Background work](<../apps/web/src/app/(workspace)/account/background-work/page.tsx>)
adds filters, bounded history pagination and an explicit page acknowledgement.
Source screens retain retry, cancellation and review actions. The assistant's own
completion dot remains independent; Phase 6C dashboards reuse these reads without
acknowledging results.

## Dashboard services (Phase 6C)

[`dashboard.ts`](../packages/core/src/services/dashboard.ts) exposes recent content,
activity, owned report shortcuts and single-project snapshots. The
[content relation](../packages/core/src/services/dashboard/content.ts) reads only
current document/table metadata with live membership and credential restrictions.
[Activity](../packages/core/src/services/dashboard/activity.ts) composes the 6B
work relation, preserving private assistant scope checks, and deduplicates matching
successful report commits before signed keyset pagination. Content spans 30 days;
terminal results span seven. Reads never acknowledge receipts.

[Snapshot SQL](../packages/core/src/services/dashboard/project.ts) caps counts at
10,000 and resolves at most 12 pins by project, kind and resource identity. Only
current Maintainer+ actors with content:write receive unavailable placeholders and
capacity. [Runtime parsers](../packages/core/src/services/dashboard/rows.ts) validate
bounded responses; [browser contracts](../packages/core/src/dashboard/schema.ts)
remain zod-only. Migrations `20260920000100` / `20260920000200` retain measured projection
indexes; owned task shortcuts use the existing owner index. Integration coverage lives in `tests/integration/dashboard.spec.ts`.

The session-only [`dashboard` router](../apps/web/src/server/api/routers/dashboard.ts)
exposes seven thin read/pin procedures. [`pins.ts`](../packages/core/src/services/dashboard/pins.ts)
requires Maintainer plus content:write, serializes the 12-pin capacity with a
Project row lock, and preserves pin identity through projection rebuilds. Candidate
search matches literal project-local titles and returns at most 20 results. Pin
storage, concurrency, rebuild and API permissions are covered by
[`projectPins.spec.ts`](../apps/web/tests/integration/projectPins.spec.ts).

[`ProjectActivityScreen`](<../apps/web/src/app/(workspace)/projects/[projectId]/_components/ProjectActivityScreen.tsx>)
renders at `/projects/<id>/activity`: a three-item active-work preview, latest
activity, shared pins, and the owner's scheduled report shortcuts filtered to
the project. The snapshot supplies its work audience; ordinary members keep
personal work. [`ManageProjectPinsDialog`](<../apps/web/src/app/(workspace)/projects/[projectId]/_components/ManageProjectPinsDialog.tsx>)
uses bounded title candidates and keeps pin removal separate from content
deletion. [Initial URL filters](../apps/web/src/lib/background-work/initialFilters.ts)
seed the existing background-work screen for the active-work preview's View
all link. `dashboard.recentContent` remains available without a UI consumer.

## Ingestion

Browser and external uploads reserve capacity before staging through
[`uploadReservations.ts`](../packages/core/src/ingestion/uploadReservations.ts)
and the `UploadReservation` model (migration `20260922220000_upload_reservations`).
Project lifecycle locks serialize retained bytes plus active reservations; a
per-user database lock caps uploads at three across projects and runtimes.
Artifact admission counts retained originals plus all concurrent staging
reservations; replacement credit is applied only at final manifest validation.
Unknown-length bodies grow their reservation before each disk write. Renewable
leases recover crashed requests; staged-file heartbeats last until promotion or
cleanup. [`imageDimensions.ts`](../packages/ingestion/src/native/imageDimensions.ts)
rejects unknown or oversized PNG/JPEG/WebP headers before native OCR decoding.

Phase 5C adds analysis and linking behind the same claim/attempt fence.
[`analyzeStage.ts`](../packages/ingestion/src/analyzeStage.ts) proposes a title,
an existing content folder, link queries, and deterministic spreadsheet column
types, then [`linkStage.ts`](../packages/ingestion/src/linkStage.ts) performs
bounded same-project, document-only keyword searches and stores at most ten
proposals. Missing model routing or unusable output keeps the parsed title with
a warning; a thrown provider call fails only analysis. Stage timestamps distinguish
queued from active work. Manual retry and `system.reconcile` republish only the
failed or stalled stage, immediately revoking a stale worker during reservation.

Reviewed drafts are accepted or rejected by
[`ingestionAccept.ts`](../packages/core/src/services/ingestionAccept.ts), exposed
as `ingestion.accept` and `ingestion.reject`. Acceptance claims the file row,
reloads the reviewed snapshot, and uses `contentOperations` under the project
repository lock for one `ingestion:<fileId>` commit. Retries recover committed
creates; finalization atomically acknowledges exactly one accepting claim.
`IngestionDraft.revision` binds a save or first accept to the version the
reviewer saw: both name an `expectedRevision`, compared under the file row lock
before any commit (`CONFLICT` on mismatch); recovery of a claimed file skips it.
Errors release only after a complete bounded Git candidate scan proves no exact
operation trailer exists; truncated or unreadable history retains accepting. Draft edits
and batch deletion lock the same file rows; deletion refuses accepting files.
Document links and search indexing follow the normal write tail. Kept links are
appended to documents as a `## Related` cross-reference list. An overflow of the
shared Markdown limit leaves the draft ready with instructions to deselect links;
review errors without a rendered field use a visible toast. Table suggestions
are navigable read-only references because tables cannot persist them. Rejection
retains both draft and original; tags remain deferred until documents gain them.

Link proposals use the bounded helpers in
[`ingestion/links.ts`](../packages/core/src/ingestion/links.ts) and reuse the
canonical 180-code-point section-anchor bound from
[`sectionAnchors.ts`](../packages/core/src/knowledge/sectionAnchors.ts), preserving
anchor identity, alongside the same-project document query extracted to
[`searchLexical.ts`](../packages/core/src/services/searchLexical.ts). OCR and
analysis route snapshots carry distinct prompt versions in
[`ingestion/route.ts`](../packages/core/src/ingestion/route.ts).

Phase 5A stores upload originals below
`${WEAVER_DATA_DIR}/files/<projectId>/`: completed blobs are project-local,
SHA-256-addressed files in two-character shards, while incomplete uploads live
in `tmp/`. [`paths.ts`](../packages/core/src/ingestion/paths.ts) validates path
identities and [`blobStore.ts`](../packages/core/src/ingestion/blobStore.ts)
owns streaming, promotion, deduplication, and age-gated cleanup. Registration,
batch deletion, and cleanup share the per-project lifecycle lock in
[`ingestion.ts`](../packages/core/src/services/ingestion.ts), so referenced
blobs survive deletion and the scheduled sweep removes only old orphans from
live projects.

That service is the authorization boundary for the whole Imports surface and
requires project Editor or higher. The streaming
[`upload route`](../apps/web/src/app/api/ingestion/uploads/route.ts),
[`ingestion` tRPC router](../apps/web/src/server/api/routers/ingestion.ts), and
project [`Imports` UI](<../apps/web/src/app/(workspace)/projects/[projectId]/imports/>)
all use it. Its per-file review route and `ReviewScreen` let Editors preview and edit
ready drafts, choose document links for the appended Related section, accept or
reject, and retry interrupted acceptance. Table links are navigable reference
suggestions because table content has no field that can persist them. Batch paging
uses a project-bound opaque cursor.

Phase 5D adds the external feed. The
[`external route`](../apps/web/src/app/api/ingestion/external/route.ts)
authenticates a personal API key only (`resolveApiKeySecurityContext` in
[`security/bearer.ts`](../packages/core/src/security/bearer.ts) refuses OAuth
tokens before verification), requires the `ingest:external` capability plus
Editor membership through `authorizeIngestionUpload(…, "external")`, applies a
per-key, single-instance in-process sliding window
(`WEAVER_INGESTION_EXTERNAL_RATE_LIMIT_PER_MINUTE`; the limiter is shared with
MCP from [`security/rateLimit.ts`](../packages/core/src/security/rateLimit.ts)),
and stores exactly one file from either a single-file multipart body or a JSON
body with base64 content. JSON authorizes the project before validating a file
field and caps decoded content at
`min(MAX_EXTERNAL_JSON_FILE_BYTES, WEAVER_INGESTION_MAX_FILE_BYTES)`.
Both routes share the streaming parser and error mapping in
[`multipartUpload.ts`](../apps/web/src/server/ingestion/multipartUpload.ts);
the JSON form lives in
[`jsonSubmission.ts`](../apps/web/src/server/ingestion/jsonSubmission.ts).
Interrupted request bodies are `400`; every `429` includes `Retry-After`,
including Better Auth's per-key fallback of 60 seconds. `finalizeUploadBatch`
records `origin = external` and the same `ingestion.parse` publication,
503-with-identity, and reconciliation contract as uploads; nothing is accepted
automatically. Sessions and OAuth tokens never carry `ingest:external`; the
browser upload route stays session-only. Every committed submission emits
`ingestion.external.submitted`.

[`createIngestionParseRunner`](../packages/ingestion/src/parseStage.ts),
[`createIngestionAnalyzeRunner`](../packages/ingestion/src/analyzeStage.ts), and
[`createIngestionLinkRunner`](../packages/ingestion/src/linkStage.ts)
receive the shared identifier-only payload declared in
[`jobs/types.ts`](../packages/core/src/jobs/types.ts); it is injected into
[`jobs/runtime.ts`](../packages/core/src/jobs/runtime.ts), which registers the
`ingestion.parse`, `ingestion.analyze`, and `ingestion.link` consumers only when
`WEAVER_WORKER_ROLES` includes `ingestion`. Missing stage runners produce a
startup warning and leave that stage queued for a worker that has the runner. A
conditional claim persists the pg-boss job/retry identity and cumulative
attempt fence before stage I/O. A null active-stage start timestamp means queued.
Parsing transitions to `extracting`, analysis
to `linking`, and linking to `ready`; duplicate and stale deliveries do
nothing, while a strictly newer retry of the same job may reclaim a crashed
stage and fences the former worker's completion, failure, and route-detail
writes. AI-stage writes also require the active start timestamp, so recovery
reservation revokes the former worker before the replacement claim increments
the attempt count.

Manual retry derives the failed parse, analysis, or linking stage from its start
or end timestamps and republishes only that stage. Scheduled recovery likewise resets
and republishes only the stale active stage; after 24 cumulative claims it
fails the file instead of publishing more work.

The ingestion file projection keeps parse, analysis, and link stage timestamps
and uses the shared `stageClaimJobId`/`stageClaimRetryCount` delivery fence for
all stage workers. Drafts persist bounded analysis `linkQueries` alongside
`proposedLinks` for the linking and review flow. Typed table drafts use the
deterministic parser and inference helpers in
[`ingestion/columnTypes.ts`](../packages/core/src/ingestion/columnTypes.ts).
Numeric inference requires lossless decimal round trips, including exact integer
values outside the safe-integer range; otherwise the column stays text and an
explicit number conversion is rejected. Native spreadsheet
[`header normalization`](../packages/ingestion/src/native/table.ts) allocates
globally unique names with room for suffixes inside the column-name limit.
The analysis runner lists folders from the document/table projections through
[`ingestionFolders.ts`](../packages/core/src/services/ingestionFolders.ts),
keeps its complete model message within its input bound, and accepts only
canonical document titles from untrusted model output. No ingestion route or
unusable output degrades to the parsed title and project root; provider setup
or call failures end the active analysis attempt as a retryable provider failure.
The link runner searches only the claimed project with bounded keyword queries,
deduplicates and caps proposals through
[`ingestion/links.ts`](../packages/core/src/ingestion/links.ts), and assigns full
confidence only when a candidate title matches the original title, analysis
phrase, or heading behind the transformed lexical query.
Ready-draft edits validate every stored table cell before accepting a column
type change and only toggle links proposed by the linking stage. The edit holds
the `IngestionFile` row lock while it reloads the live project and ready state,
validates the current draft, and writes it, serializing review with acceptance.

Parsing goes through the [`DocumentParser`](../packages/ingestion/src/parser.ts)
port. [`selectParser.ts`](../packages/ingestion/src/selectParser.ts) prefers
the [Docling adapter](../packages/ingestion/src/docling.ts) for the PDF and
image types it supports whenever
[`services/ingestionSettings.ts`](../packages/core/src/services/ingestionSettings.ts)'s
docling-serve base URL is configured, falling back to the
[native adapter](../packages/ingestion/src/native/index.ts) only when Docling
is unreachable (any other Docling failure is terminal) or no endpoint is
configured. The selected adapter's id and version are recorded before parsing
starts. Word and PDF uploads become document drafts; Excel and CSV uploads
become table drafts, bounded by column/row/cell/byte limits in
[`draftTable.ts`](../packages/core/src/ingestion/draftTable.ts) — an empty
spreadsheet is a validation failure, not an empty draft.

Scanned PDF pages and standalone images are transcribed by the
[OCR client](../packages/ingestion/src/ocr.ts) over the current `ingestion`
LLM route; its resolved route snapshot is recorded before the first vision
call. No route, or a route whose model does not declare the `vision`
capability, fails the file as `blocked_configuration` with a message pointing
back to Administration › Settings › AI; a manual retry moves it back to `pending` once a
route is fixed. `WEAVER_INGESTION_MAX_OCR_PAGES` (default 50; `0` disables
OCR) caps vision calls per file: PDF pages beyond the budget are skipped with
a warning on the completed draft, not a failure, but a standalone image at
`0` fails outright instead of degrading. A `MAX_OCR_WALL_CLOCK_MS` deadline
and an unrenderable-page skip degrade the same way, both inside the longer
`ingestion.parse` lease (`INGESTION_PARSE_EXPIRE_IN_SECONDS`) so pg-boss never
redelivers a scan that is still calling the provider. Rendered PDF pages are
capped at the same 2048 px long edge as standalone images, since a MediaBox is
attacker-controlled. `system.reconcile` scans at
most 100 old database rows per run for missed publication or stalled processing
using the longest ingestion queue lease (currently 60 minutes) as its minimum
age. `WEAVER_INGESTION_TMP_TTL_MINUTES` independently controls upload storage
cleanup for all live projects; a file that reaches
`MAX_INGESTION_ATTEMPTS` ends as an `internal` failure instead of being
republished forever. Known limitation: `exceljs` and `mammoth` decompress
XLSX/DOCX archives before their size can be checked, so both worker containers
carry a compose `mem_limit` as the interim guard. Only explicit acceptance
writes ingestion content to Git.

The compose deployment splits worker roles across two containers built from
one `docker/worker.Dockerfile` image: `agent-worker` narrows to
`WEAVER_WORKER_ROLES=knowledge,assistant,tasks,git` while a separate `ingestion-worker`
runs `WEAVER_WORKER_ROLES=ingestion` on its own health port (3102), so a slow
vision call cannot starve assistant runs sharing the other container. See the
[`weaver-ingestion` skill](../.claude/skills/weaver-ingestion/SKILL.md) and run
`pnpm test:integration:ingestion` for the area suite.

Uploads expose progress and cancellation, normalize supported CSV MIME aliases,
and stop reading after a terminal upload failure. Active staging leases protect
multipart files from cleanup. Sweep filesystem work runs outside database
transactions; parse handlers detect unsupported formats before reading originals.
Parser output is validated before transitions, and CSV preview parsing honors quoted
fields and escapes Markdown cells.

## Artifacts (Files)

Upload admission reserves staged bytes without filename-based replacement credit;
finalization still computes actual replacement retention. Downloads handle signals
already aborted during stream opening. Notebook enqueue failure defers dispatch to
reconciliation while preserving the committed result and continuing cleanup.
The shared archive guard verifies actual per-entry decompression against declarations
and the aggregate expansion budget before any JSZip-based parser receives the bytes.

Downloads export an explicit metadata-only `HEAD` handler, avoiding file handles
and stream slots. GET size-limit failures return 413 and service failures retain
their HTTP status. Rename rechecks magic bytes when the extension changes type.
OneNote snapshot publication checks retained bytes under the lifecycle lock and
records `quota_exceeded` without retaining the snapshot when it cannot fit.

Slice 1 of the project artifact store adds a plain "Files" area per project:
originals of any type, uploaded, downloaded, renamed, and deleted, with no
parsing and no knowledge-pipeline involvement. It reuses Imports' project-local,
content-addressed blob store and lifecycle lock instead of introducing a
parallel one.

The `Artifact` model (`packages/db/prisma/schema.prisma`, migration
`20260922001200_artifact_store`) stores `filename` plus an NFKC-normalized,
lower-cased `filenameKey` that is the per-project identity
(`@@unique([projectId, filenameKey])`), `contentDigest`, `byteSize` (a
Postgres `INTEGER`, not `bigint`), and a
`contentType` derived from the filename extension.
[`services/artifacts.ts`](../packages/core/src/services/artifacts.ts) is the
sole gateway: list/get require Viewer, upload/rename/delete require Editor,
and upload/rename/delete all run under the shared
`withProjectIngestionLifecycleLock`. Finalizing an upload batch is
all-or-nothing — every file's name-conflict check runs before any write — and
maps a same-name unique-index race to `CONFLICT`.

[`ingestion/blobReferences.ts`](../packages/core/src/ingestion/blobReferences.ts)
is the shared definition of "this digest is still referenced" and of retained
bytes for the upload quota; it unions `IngestionFile` and `Artifact`, so a
digest already held by an import costs nothing extra when also uploaded as a
Files artifact, and the orphan sweep leaves a blob alone while either table
still names it. `packages/core/src/artifacts/filenames.ts` and `contentTypes.ts`
own filename validation (dot-prefixed, control character, path separator, and
NFKC-key-length checks) and content-type derivation (extension-based, with
byte sniffing that only ever rejects a contradiction against a small set of
known magic bytes).

The upload route
([`api/projects/[projectId]/artifacts/route.ts`](../apps/web/src/app/api/projects/[projectId]/artifacts/route.ts))
and download route
([`.../[artifactId]/download/route.ts`](../apps/web/src/app/api/projects/[projectId]/artifacts/[artifactId]/download/route.ts))
reuse the streaming multipart parser in
[`multipartUpload.ts`](../apps/web/src/server/ingestion/multipartUpload.ts)
through its `extraField` (accepts repeated `replace` fields) and
`resolveContentType` hooks, in place of the Imports MIME-allowlist path. Only
`projectId` has to precede the `file` parts; `replace` fields may appear
anywhere, because they are read after the body is parsed. The
project storage quota error is `400`, the same status the Imports route uses
for it (not `413`, which stays reserved for byte-size limits). The download
route collapses every failure to a generic "not found", answers `404` (not
`400`) for a non-UUID project or artifact id, and additionally maps
`FORBIDDEN` to `404`. It answers `304` from the stored digest before touching
disk, then streams the blob (`openArtifactStream` in
[`services/artifacts.ts`](../packages/core/src/services/artifacts.ts): an
`O_NOFOLLOW` handle piped through an incremental SHA-256 verifier that errors
at the end of the body on a mismatch) with `content-length`, and caps
in-flight downloads at four per user (`429`, `retry-after: 15`).
`withProjectIngestionLifecycleLock` hashes the lower-cased project id so every
caller serializes on one key. The [`artifact` tRPC router](../apps/web/src/server/api/routers/artifact.ts)
covers list, rename, and delete; upload is HTTP-only, matching Imports.

The project [Files page](<../apps/web/src/app/(workspace)/projects/[projectId]/artifacts/>)
(`ArtifactsScreen`) lists, searches, sorts, and paginates artifacts, uploads
via drag-and-drop with a replace-confirmation step for name collisions, and
renames/deletes through dialogs; every member can download, Editors can
upload/rename/delete. It has not yet been exercised in a real browser or by
an e2e spec — coverage is the colocated component tests plus
`apps/web/tests/integration/artifacts.spec.ts` (`pnpm test:integration:artifacts`).

Slice 2 adds [`@weaver/artifact-readers`](../packages/artifact-readers/), a
pure leaf package of read-only functions — no side effects, no `@weaver/*` or
Node fs/process/network imports: a shared ZIP/OOXML archive guard (`archive.ts`, also now used by
`packages/ingestion`'s `archiveIssue` as a thin adapter) plus readers for
Word (`word.ts`), Excel (`excel.ts`), PDF (`pdf.ts`), and JSON (`json.ts`).
Every caller-actionable failure is a typed `ArtifactReadError` with one of
eight codes. The package is not wired into any router, MCP tool, or the
assistant yet — outside its own tests it is imported only by
`packages/ingestion`, by the archive guard and by the two PDF interop tests
with their fixture module. Its limits bound **bytes read, never heap**: a
Word part at the 16 MiB part bound still becomes a multi-hundred-megabyte
DOM, ExcelJS and `JSON.parse` are unbounded at honest sizes, and every reader
is synchronous CPU-bound code no timeout can pre-empt — so slice 3 must run
all of them behind process isolation with a heap cap and a kill timeout, the
way `packages/ingestion/src/native/isolated.ts` runs Imports' native parsers.
See the
[`weaver-artifacts` skill](../.claude/skills/weaver-artifacts/SKILL.md)'s
"Readers package" section for the full detail, including its "How slice 3
handled it" list.

The shared contracts in [`artifactsText.ts`](../packages/assistant-tools/src/tools/artifactsText.ts),
[`artifactsCsv.ts`](../packages/assistant-tools/src/tools/artifactsCsv.ts) and
[`artifactsStructured.ts`](../packages/assistant-tools/src/tools/artifactsStructured.ts)
add `read_text_artifact`, `read_csv_artifact` and `inspect_structured_artifact` to
both assistant and MCP. Source reads cover TXT/Markdown/YAML/CSV; CSV reads retain
original string cells; structure inspection covers JSON/YAML. Overview adds text
line counts/Markdown headings, CSV columns and YAML root shape; search adds
case-insensitive literal matching across the whole text/CSV source (default 25,
maximum 100 matches). JSON queries also accept YAML, with JSONPath inputs up to
8,192 UTF-8 bytes and unchanged grammar/dotted-field projection. Existing
Word/DOTX, XLSX, PDF, JSON and cached OneNote contracts remain compatible.

The [operation catalog](../packages/core/src/artifacts/readerOperations.ts) uses
allowed format arrays. Validated `.txt`/`.md`/`.csv`/`.yaml`/`.yml` filenames supply
a fallback only for stored `text/*` or `application/octet-stream` metadata, so old
YAML uploads are readable without replacement; new YAML uploads/renames store
`application/yaml`. Every operation retains Viewer/digest/abort checks and child
isolation. Text clipping and source positions stay inside `readerChild`; complete
JSON envelopes, escaped strings and signed cursors fit 16,000 UTF-8 bytes and
resume at unsent content. Text continuation accepts an omitted `startLine` or the
original selected start; CSV repeated `startRow` must equal the actual resumed
row. Query options and content digests bind cursors, while page limits remain
adjustable. Section ids exclude explicit start/end lines. Raw-source reads recover
oversized CSV cells and YAML rejected by structured parsing. File-derived strings
remain untrusted; files re-parse per isolated call without a persistent parser cache.

[`text.ts`](../packages/artifact-readers/src/text.ts) adds pure text/Markdown
reads, outlines and literal search behind the additive `./text` subpath. It owns
strict UTF-8 decoding, source line locations and surrogate-safe 128 KiB text
windows; line ranges preserve CRLF/LF/CR and Markdown sections use positional
`heading-<line>` ids. Outlines use directly pinned `markdown-it` 15.0.2 CommonMark
block tokens and physical source-line maps, recognizing container headings while
excluding fences and HTML blocks/comments. Only normalization/block rules run;
raw titles retain inline syntax and sections slice original source bytes. Unlimited
logical nesting avoids silent omissions; parser failures return fixed resource
errors under the existing child limits, with raw-line recovery. Search and outlines
page across the whole source. The same module exposes decoder/location helpers for
other leaf readers and the isolated child.

[`csv.ts`](../packages/artifact-readers/src/csv.ts) (`./csv`) adds original-string
CSV overview, row windows and complete logical-cell search. It preserves indexed
duplicate/empty headers, irregular widths, trailing cells and quoted source line
endings; source record line ranges support raw-text recovery. Overview columns
page across maximum source width; row metadata and cells share a serialized
128 KiB cap with explicit omissions and value truncation, so very wide rows still
advance and later columns remain selectable. The canonical artifact skill records
projection, metadata and cursor semantics.

[`yaml.ts`](../packages/artifact-readers/src/yaml.ts) (`./yaml`) normalizes a
single YAML 1.2 core-schema document into `JsonValue`. It validates the AST and
preflights expanded aliases before iterative materialization: at most 100 literal
aliases, depth 512 and 200,000 normalized values/containers; cycles, duplicate or
non-string keys, unsupported tags and non-finite numbers fail with fixed errors.
Mapping-key aliases resolve to string scalars and duplicate names fail after
resolution. Dates stay strings and hostile property names remain own data. The exact `yaml`
dependency is pinned in the readers package. [`json.ts`](../packages/artifact-readers/src/json.ts)
exports `parseJsonValue`, `overviewJsonValue` and `queryJsonValue` for pure shared
structure/query work; JSON and YAML keep the existing JSONPath and dotted-field
projection behavior.

[`structured.ts`](../packages/artifact-readers/src/structured.ts) (`./structured`)
owns `inspectStructuredValue`; `inspectJson`/`inspectYaml` reuse parsed values.
Exact own-key JSON Pointers (default `""`) and bracketed paths select any array
element. Depth
is relative to the selected root (0–5, default 2), pages default to 50 nodes
(maximum 200), objects use lexical key order, and arrays expose only their first
20 elements with incomplete-coverage metadata. Values are omitted unless requested;
scalar samples cap at three per node and 80 UTF-8 bytes per string. Emitted nodes
whose combined JSON-serialized `{ pointer, queryPath }` addresses exceed 8 KiB
fail with actionable `resource_limit`, as do oversized selected-pointer headers
even on empty pages. A node/header/envelope/cursor combination that exceeds the
smaller tool budget returns `BAD_REQUEST` with shorter-ancestor guidance, never
truncated addresses. Other pages remain accessible and later object keys are
never silently dropped.

Slice 3 adds ten read-only tools
(`search_artifacts`, `get_artifact_overview`, `search_artifact_text`,
`query_json_artifact`, `read_pdf_pages`, `read_word_chapter`,
`read_word_blocks`, `find_word_tables`, `read_word_table`,
`read_excel_sheet`) in
[`packages/assistant-tools/src/tools/{artifacts,artifactsWord,artifactsShared}.ts`](../packages/assistant-tools/src/tools/artifacts.ts),
registered directly after `aggregate_table` in `ASSISTANT_TOOLS` and
therefore part of `MCP_TOOLS` too. Every reader call runs in a forked child
process, never in-process — `runArtifactReader`
([`readerProcess.ts`](../packages/core/src/artifacts/readerProcess.ts))
forks [`readerChild.ts`](../packages/core/src/artifacts/readerChild.ts), the
only module that loads a reader subpath at runtime — with a 512 MiB heap
cap, a 1 GiB RSS watchdog (the isolated-parser watchdog moved to
[`packages/core/src/process/memoryMonitor.ts`](../packages/core/src/process/memoryMonitor.ts)
and shared with Imports), a 60 s timeout (120 s for PDF, covering the wait
for a slot), at most 2 concurrent children, and an 8-deep wait queue beyond
which a call fails immediately with `TOO_MANY_REQUESTS`. The child reads and
SHA-256-verifies the blob itself; only identifiers cross the IPC boundary,
and the child's serialized result is capped at 2 MiB (UTF-8 bytes, checked
again by the parent after receipt) and never trusted blind by the parent. So
that the cap never defeats tool paging, `word.chapter` and `word.table` take
`fromBlock`/`maxBlocks` and `fromRow`/`maxRows` windows (default 200, max 500)
that the tool cursors drive, and outlines, table inventories and JSON
overviews cap at 5,000 entries with a `truncated` flag. A child that dies
with `SIGABRT` and no result (a V8 heap-limit abort) is reported as a
`memory` failure, not a crash. Each tool call forks and re-parses the file — there is
no cache — and `get_artifact_overview` on a Word file forks twice. Over MCP
those deadlines rarely decide anything: the MCP server aborts every tool
call at `WEAVER_MCP_TOOL_TIMEOUT_MS` (1,000–120,000 ms, default 30 s), well
inside the reader's own 60 s/120 s, and that abort travels down the signal
and SIGKILLs the child — raise the variable before blaming the reader for a
large file that "always times out" over MCP.

Word files without heading styles get an outline: the reader takes headings
from `Heading N` styles, outline levels (own or inherited through `basedOn`)
and, failing both, infers them from font size and bold titles
([`word/typography.ts`](../packages/artifact-readers/src/word/typography.ts),
[`word/structure.ts`](../packages/artifact-readers/src/word/structure.ts));
the overview reports `outlineSource` and marks inferred chapters.
An effective `w:outlineLvl=9` keeps a paragraph as body text, overriding
inherited headings, `Heading N` style names and typography inference.
`read_word_blocks`
([`artifactsWord.ts`](../packages/assistant-tools/src/tools/artifactsWord.ts))
reads a Word file from any block id, so a search hit can be read in place.
Pictures in Word files are returned as `weaver-image:` references
([`word/images.ts`](../packages/artifact-readers/src/word/images.ts)); a
document write copies them in process through
[`wordImages.ts`](../packages/core/src/artifacts/wordImages.ts) and
[`documentImageImports.ts`](../packages/core/src/services/documentImageImports.ts).
The first `read_word_table` page also requests header-row pictures through the
reader's `includeHeaderImages` option, without changing data-row pagination.
See the `weaver-artifacts` skill's "Word outline and positions" and "Word
images".

Every tool returns `{ artifact: { id, filename, contentType, byteSize,
sha256, updatedAt, url }, result }` (`search_artifacts`: `{ page, total,
truncated, items }`); `url` is the app-relative Files-page link `?file=`,
which the Files page now pre-fills into its search box (bounded by the 200
characters its list input accepts) and remounts on a new deep link. The
in-app assistant transcript prefixes app-relative links with the
deployment's base path (`withAssistantBasePath` in
[`AssistantMarkdown.tsx`](../apps/web/src/components/assistant/AssistantMarkdown.tsx));
MCP clients receive the app-relative path and resolve it against the
deployment's base URL themselves. Reader failures map through
[`services/artifactReads.ts`](../packages/core/src/services/artifactReads.ts):
`not_found` → `NOT_FOUND`; `resource_limit` and `unavailable` with cause
`timeout`/`memory` → `BAD_REQUEST`/`PAYLOAD_TOO_LARGE`; `unavailable` with
cause `crashed`/`not_started` → `INTERNAL_SERVER_ERROR` (the generic
`INTERNAL` "tool failed" for tool callers; `busy` reaches them as
`TOO_MANY_REQUESTS` with a fixed retry hint) plus an `artifact.reader.failed`
diagnostic carrying the cause, operation, artifact and the child's exit
status; `busy` — the queue full, or a deadline that expires while the read is
still waiting for a slot — → `TOO_MANY_REQUESTS`; everything else → plain
`BAD_REQUEST`; a tool called on the wrong file type names the right one. Cursors — including
`query_json_artifact`'s `nextCursor`, whose `offset` only starts a fresh
read — are signed
(`weaver-artifact-cursor-v1:`,
[`artifactCursors.ts`](../packages/core/src/services/artifactCursors.ts))
and bound to `{ tool, projectId, artifactId, contentDigest, query }`: a
replaced file fails `STALE_BASE`, any other mismatch fails
`INVALID_CURSOR`. Because every tool looks the artifact up twice (describe,
then read), the digest it loaded is compared with the one the call was built
from and fails the same `STALE_BASE` when a replace lands in between. `read_excel_sheet`'s workbook form (no `sheetName`) resumes
by replaying the reader's own page with a row skip, since
`readExcelWorkbook` reports no worksheet index per sheet. Output is bounded
by the shared 16,000-byte (UTF-8) budget with added clamps for file-derived
head strings and repeated header rows, `omittedPageTail` for a PDF page
longer than the reader's 100,000-character window, and `omittedSheetCount`
for a workbook wider than the overview keeps. No artifact citations, no
parsed-structure cache, and no test has read a file produced by a real
Word/Excel/PDF writer — see the
[`weaver-artifacts` skill](../.claude/skills/weaver-artifacts/SKILL.md)'s
"Tools (slice 3)" and "Open after this slice" sections for the full detail,
and `weaver-assistant` for the tool registry and prompt-budget numbers.

OneNote `.onepkg` (CAB) and `.one` artifacts add a separate cached reader for
assistant/MCP tools. [`read_onenote`](../packages/assistant-tools/src/tools/artifactsNotebook.ts)
lists sections and pages, searches text and reads individual pages with signed,
revision/query-bound continuations. Text includes table rows and image/attachment
descriptions. `get_artifact_overview` and `search_artifact_text` share the cache;
initial reads report preparation status. Missing-cache statuses and read errors
explicitly direct the agent to `read_onenote` with `action="sections"` and
`retry=true`; queued/running states tell it to wait, and failed rebuilding must
be reported instead of retried repeatedly. Agents can use the existing document
creation tools afterwards. Originals remain downloadable through Files.

[`services/artifactNotebooks.ts`](../packages/core/src/services/artifactNotebooks.ts)
owns Viewer-authorized preparation and reads. `ArtifactNotebook` (migration
`20260922001300_artifact_notebooks`) records status, source digest, parser version
and claim identity. `artifact.notebook.prepare` runs on ingestion workers through
[`artifactNotebookJobs.ts`](../packages/core/src/services/artifactNotebookJobs.ts)
and the isolated [`@weaver/ingestion/notebook`](../packages/ingestion/src/notebook/runner.ts)
process adapter. The [Rust executable](../packages/ingestion/native/onenote-reader/)
uses a vendored MPL-2.0 OneNote parser with documented recovery patches. Its output
follows the shared [snapshot schema](../packages/core/src/artifacts/notebookSchema.ts);
[`notebookStorage.ts`](../packages/core/src/artifacts/notebookStorage.ts) validates
every page and image before publishing readiness. Snapshots live under
`WEAVER_DATA_DIR/notebooks/<project>/<artifact>/<digest>/<parserVersion>/<claim>`.
Replacement and claim fences prevent stale publication or reads;
`system.reconcile` recovers interrupted preparation, re-queues rows from an older
parser version or source digest, queues notebook files that were never prepared,
and removes abandoned caches, isolating per-row errors so one notebook cannot
block the sweep. Uploading, replacing or renaming a file to `.one`/`.onepkg`
queues preparation in the same lifecycle-locked transaction
(`queueNotebookPreparation`); the Files page lists each notebook's status with
page/section counts (`ArtifactNotebook.sectionCount`, `pageCount`,
`emptySectionCount`, `unreadableSectionCount`, set on publish) and polls while
preparation is queued or running. `sweepArtifactNotebook` removes an artifact's
non-current notebook files and its emptied directories under the lifecycle lock;
delete, replace, rename-away, a failed or fenced build, and the reconcile sweep
all use it, so a deleted file leaves nothing under `notebooks/`. Claims create
their directory under the same lock. The reader marks each section `parsed`,
`empty` (no stored content revision, typically a cloud section OneNote had not
downloaded before export) or `unreadable` (manifest `schemaVersion` 2, parser
version 2). A current
notebook is answered without the project lifecycle lock; a rebuild after a
preparation failure is refused for `NOTEBOOK_RETRY_COOLDOWN_MS` (10 minutes,
reported as `retryAllowedAt`), while a missing cache (`snapshot_unavailable`)
can be rebuilt immediately. The published snapshot size is stored in
`ArtifactNotebook.snapshotBytes` and counted into the project's retained bytes
(`blobReferences.ts`). Over MCP `read_onenote` carries `readOnlyHint: false`
because it can enqueue preparation.

Files have a separate `WEAVER_ARTIFACT_MAX_FILE_BYTES` cap (512 MiB default and
maximum, matching the OneNote reader's source limit).
Local setup requires `pnpm notebook:build`; the worker Docker image includes the
executable. Preparation creates no ingestion drafts or Weaver documents, but page
images can be copied into documents: `read_onenote` shows them as
`![alt](weaver-image:<file id>/<image id>)` references, and document writes copy
referenced images (and `weaver-image:<file id>` image files from Files) into the
document's `.assets` directory
([`documentImageImports.ts`](../packages/core/src/services/documentImageImports.ts)).
The reader uses OneNote's browser-compatible "web picture" when the primary image
is in another format or absent (parser version 3). Exact
canvas layout, OCR, ink and editing are outside this reader; extraction warnings
remain visible in tool results. See [`artifactNotebooks.spec.ts`](../apps/web/tests/integration/artifactNotebooks.spec.ts)
and [`artifactNotebookTools.spec.ts`](../apps/web/tests/integration/artifactNotebookTools.spec.ts).

## LLM connections and routing

Declared context/output budgets are positive or unset in shared schemas, services
and forms; [the budget migration](../packages/db/prisma/migrations/20260922220200_positive_model_budgets/migration.sql)
normalizes legacy zero values to null and enforces database CHECKs. Prompt admission
uses conservative UTF-8 bytes as a token upper bound. Assistant/task accounting
starts only when a model invocation begins and retains SDK error usage when present;
unavailable token counts remain unknown.

`WEAVER_ENCRYPTION_KEYS` is the versioned AES-256-GCM key ring; the highest
version is active for writes while every listed version remains available for
decryption. Core ownership is split between
[`llmConnections.ts`](../packages/core/src/services/llmConnections.ts) for
connections, models, write-only credentials, tests, and rotation, and
[`llmRoutes.ts`](../packages/core/src/services/llmRoutes.ts) for purpose routes,
health, and resolved snapshots. The `llm` tRPC router uses `adminProcedure`, and
the services independently require `llm:admin`; `system:admin` implies that
capability, never the reverse. `ACTIVE_LLM_PURPOSES` includes `assistant`,
`knowledge_extraction`, `knowledge_embedding`, `ingestion` ("Import parsing"),
`jobs` ("Scheduled tasks"), and optional `document_summary` ("Document change
summaries"). The latter three require `chat`; Imports additionally checks `vision`
at scan/image transcription time. Document summaries bound input against declared
context metadata, using a conservative 4,096-token budget when it is absent, and
fall back silently when the request cannot fit. The enum addition
lives in [`20260921001200_document_summary_route`](../packages/db/prisma/migrations/20260921001200_document_summary_route/migration.sql).

[`apps/agent-worker/src/index.ts`](../apps/agent-worker/src/index.ts),
[`apps/web/src/instrumentation.ts`](../apps/web/src/instrumentation.ts), and
[`apps/mcp-server/src/index.ts`](../apps/mcp-server/src/index.ts) refuse
startup when stored credentials reference a key version absent from the ring
or a sampled credential cannot be decrypted with its configured key.
Follow the canonical [key rotation procedure](setup.md#rotate-encryption-keys)
for all three runtimes. Global Admins configure
connections, declared models, and purpose routes under
[`apps/web/src/app/(workspace)/admin/ai/`](<../apps/web/src/app/(workspace)/admin/ai/>).

Provider adapters live under [`packages/core/src/ai/`](../packages/core/src/ai/):
[`openaiCompatible.ts`](../packages/core/src/ai/openaiCompatible.ts) (OpenAI
and generic endpoints, plus OpenRouter),
[`anthropic.ts`](../packages/core/src/ai/anthropic.ts),
and the [`lmStudio.ts`](../packages/core/src/ai/lmStudio.ts) /
[`ollama.ts`](../packages/core/src/ai/ollama.ts) wrappers, which call the
server root's `/v1` API for completions and embeddings and discover models
natively (`/api/v0/models`; `/api/tags` plus a bounded `/api/show` fan-out).
The provider-neutral `completeText` method supports bounded, cancellable plain-text
requests for document comments through the same credential and HTTP boundary.
OpenRouter connections use the fixed `https://openrouter.ai/api/v1` endpoint and
require an API key. An Admin declares or imports an OpenRouter model, then may
select its upstream provider in the model editor. Automatic routing stores no
pin; [`openrouter.ts`](../packages/core/src/ai/openrouter.ts) retrieves bounded,
model-specific choices from `/models/:author/:slug/endpoints`. A selected
provider is stored on the model and sent as `provider.only` on core completion,
probe, and embedding requests and on AI SDK assistant/task streams. Other
provider types do not receive that OpenRouter request field.
`listModels` returns `DiscoveredModel`s — display name, context window, max
output tokens, embedding dimensions, capabilities, and a `source` —
and [`modelDiscovery.ts`](../packages/core/src/ai/modelDiscovery.ts) fills
gaps from [`modelCatalog.ts`](../packages/core/src/ai/modelCatalog.ts) (hosted
OpenAI/Anthropic families) or inferred defaults; endpoint values always win.
Generic OpenAI-compatible discovery also accepts LiteLLM's model-list fields
(`max_input_tokens`, `max_output_tokens`, and `mode`) and merges LiteLLM's
`/model/info` (`mode`, `supports_function_calling`, `output_vector_size`,
limits) when the endpoint serves it; other servers answer 404 and the public
list stands alone. It does not infer tool use from provider model names: when
neither source carries capability metadata, an Admin must declare that
capability on the imported model.
`llm.testConnection` returns up to 500 discovered models and
`llm.importModels` declares the selected ones in bulk, probing embedding
dimensions (bounded) when the endpoint does not report them and optionally
refreshing the limits of already declared models; the
[`ImportModelsDialog`](<../apps/web/src/app/(workspace)/admin/ai/_components/ImportModelsDialog.tsx>)
opens after every successful test and after creating a connection. LM Studio
and Ollama connections store the server root and may have an empty credential
(encrypted like any other, sent as no `Authorization` header). Imports retain
their native dimensions and `native` mode; only an Admin editing a declared
embedding model can explicitly enable Matryoshka reduction. Connection/model
tests call the same adapter finalization path as runtime embedding work.

OpenAI probes use its completion-token parameter, and embedding usage reports
zero output tokens so input-only pricing remains calculable. Discovery/import
deadlines become controlled provider failures. Partial model edits serialize on
their model row; keyless local connection edits explicitly clear credentials when
the origin changes. Connection/model outcomes emit diagnostic events, and
[`aiUsageBestEffort.ts`](../packages/core/src/services/aiUsageBestEffort.ts)
reports accounting failures without discarding completed provider responses.
`LlmModel.maxOutputTokens` is carried in route snapshots and caps the assistant
output reservation and provider request, alongside its context-window budget.
Thinking effort belongs to each purpose route, so several routes can use the
same declared model with different settings. `provider_default` sends no
override; `none` requests thinking off where supported; `low`/`medium`/`high`
request increasing effort. Knowledge embeddings do not use a thinking setting.
The route form and `set_llm_route` MCP tool share this setting through
[`llmSchemas.ts`](../packages/core/src/services/llmSchemas.ts).

Provider discovery shares bounded model identifiers and capability limits, cancels
remaining probes after failure, and resolves credentials once per connection attempt.
Connection edits invalidate retained adapters with a retryable error; provider
credentials reject control characters and error logs exclude their text. Route cache
invalidation is process-local with a 15-second refresh in other runtimes.

`setLlmRoute`, `updateLlmModel`, and `updateLlmConnection` each return
`reindexProjects`, the number of live projects `withKnowledgeRoutingChange`
queued for reconciliation because the save changed the knowledge index
fingerprint; it is `0` for extraction-only, thinking-effort, or no-op saves.
Administration › Settings › AI surfaces that count after a save that reindexes.

[`llmVectorSpace.ts`](../packages/core/src/services/llmVectorSpace.ts) lets an
Admin declare two embedding models as interchangeable: `verifyEmbeddingCompatibility`
embeds 8 fixed samples on both models and requires a minimum cosine similarity
of 0.98 (`compareEmbeddingSamples` in
[`embeddingCompatibility.ts`](../packages/core/src/ai/embeddingCompatibility.ts));
a successful check assigns both models the same `LlmModel.vectorSpaceKey` — the
key of whichever model is currently routed to `knowledge_embedding` wins — so
switching the route between them afterward is a `compatible` no-op rather than
a reindex. `clearEmbeddingCompatibility` resets a model's vector-space fields;
editing a model's identity (connection endpoint, provider model id, upstream
provider, embedding dimensions, or dimension mode) clears it the same way.
`previewClearEmbeddingCompatibility` (`none` / `reindex` plus a project count)
reports whether a clear changes the live index fingerprint, and
`VectorCompatibilitySection` asks for confirmation before a clear that
reindexes. Verification writes the shared key only while both models and their
connections still have the identity that was compared (`CONFLICT` otherwise).
The `ModelDialog` embedding-model edit form
renders `VectorCompatibilitySection`, offering only candidates with matching
embedding dimensions and mode. `previewKnowledgeRouteChange` (`none` /
`extraction_only` / `compatible` / `reindex`, plus a project count for
`reindex`) backs `KnowledgeRouteConfirmDialog`, which the Routes card opens
before actually switching the `knowledge_extraction` or `knowledge_embedding`
model so an Admin sees the consequence before confirming. The MCP-only
`set_embedding_compatibility` tool (`packages/assistant-tools/src/tools/admin/llmWrite.ts`)
exposes the same verify/clear pair.

## Assistant backend

`services/externalMcp/capacity.ts` serializes per-owner capacity changes and projects
only reviewed runtime schemas (10 stored connections, 100 enabled tools, 2 MiB total).
Loaded connections register tools into the shared execution map at acceptance time.
The assistant deadline is checked again after the turn and final citation validation.

[`assistant/principal.ts`](../packages/core/src/assistant/principal.ts) checks the
originating live session and current ban/password-change state at lease, heartbeat,
native tool/model-step admission, completion and automatic proposal acceptance.
Retry `run.started` events reset stale proposal/citation state. External approvals
remain bound to the originating browser session; their card explains this boundary.

Conversations, runs, and proposals are owned by
[`assistantConversations.ts`](../packages/core/src/services/assistantConversations.ts),
[`assistantRuns.ts`](../packages/core/src/services/assistantRuns.ts), and
[`assistantProposals.ts`](../packages/core/src/services/assistantProposals.ts);
scope snapshots, events, actor/route snapshots, and citation validation live under
[`packages/core/src/assistant/`](../packages/core/src/assistant/). Reading
stored citations back for the panel is
[`assistantCitations.ts`](../packages/core/src/services/assistantCitations.ts)
(`assistant.listCitations`): it rechecks project access per citation, drops the
label, excerpt, and locator fields of a source the user may no longer see, and
projects a document citation's `navigationAnchor` from the cited revision's own
headings using the same `projectDocumentSectionAnchors` projection the chunker
indexes with. An accepted `document.create`/`table.create` proposal records the
id it created as the proposal's `resourceId`, so the panel can link to what was
just created. The web app
publishes `assistant.run` jobs; [`@weaver/ai`](../packages/ai/src/runner.ts)
leases the run in the agent worker, composes a per-request-credential language
model from the `assistant` route, runs the Vercel AI SDK tool loop over the
thirty-four contracts (twenty-seven read, seven propose) in
[`@weaver/assistant-tools`](../packages/assistant-tools/src/registry.ts),
appends sequenced events, validates resource/revision provenance and derives
citation excerpts from Git, and records usage. `navigate_document` reads one
document's outline, one section (heading plus descendants), or literal
matches, all pinned to one snapshot; section ids come from its outline and
are revision-scoped. `document.patch`
(`propose_document_patch`/`patch_document`) changes a document by exact text
or by section instead of resubmitting the whole body, and `table.change`
(`propose_table_change`/`change_table`) changes a table's title, columns,
select options, and rows together in one revision, validating only the
combined final state. Both new operation variants commit through the
existing `applyOperationInRepo`, so attribution, locking, projections, and
MCP recovery are unchanged. `propose_table_schema_change` and
`propose_table_rows` are retired from `ASSISTANT_TOOLS`, and because
propose-kind tools never reach `MCP_TOOLS`, both tool definitions were
deleted outright as unreachable rather than merely hidden; their `table.schema`/`table.rows` operation variants and the MCP
`update_table_schema`/`update_table_rows` tools are unchanged, so proposals
pending before the retirement stay acceptable. `content_history`
(mode=versions/diff/deleted) is generic over documents and tables: it lists a
resource's commits, compares two of its revisions, or lists deleted documents
and tables across the project. Deleted-item discovery
([`contentRecovery.ts`](../packages/core/src/services/contentRecovery.ts))
reads committed `D` (delete) records from Git history rather than a database
projection or commit trailer, so a document or table removed through the web
UI — which leaves no proposal or MCP audit trail — is still found. The
signed recovery cursor resumes within a deletion commit when a page fills;
legacy position-zero cursors still advance past the entire commit. The
`content.restore` operation, exposed as `propose_content_restore` (assistant)
and `restore_content` (MCP direct write), restores an earlier version
(mode=version, guarded by `expectedHeadCommitSha`) or recovers a deleted item
with its original UUID (mode=deleted, guarded by `deletedAtSha`); recovery
never overwrites a live resource sharing that id, and both modes write a new
commit rather than rewriting history. Because a deleted recovery brings its own
identity, `recoverPriorOperation` also covers it: a lost acknowledgement
replays the earlier commit found by its `Weaver-Operation-Id` trailer, and Git
is consulted as a second witness before writing, so an identity whose file is
committed but whose projection row is missing is repaired and refused rather
than committed twice. A restore proposal's stored kind names its resource type
(`content.restore.document` / `content.restore.table`) so the approval card
links and invalidates the right area. `content.restore` is deliberately
excluded from `AUTO_APPROVABLE_KINDS`, so a restore proposal always awaits
review even in a conversation with auto-approve enabled, because it replaces
live content from a historical revision. `content.lifecycle` (design §7) adds
folder create/rename/move/delete-empty and item move/delete over documents and
tables, exposed as `list_content_folders` (read),
`propose_content_lifecycle` (assistant) and `apply_content_lifecycle` (MCP).
Folder deletion is never recursive and roots are unaddressable. Folder actions
guard on the `baseProjectCommitSha` a pinned `list_content_folders` returned
and are rechecked against project HEAD under the write lock; item actions
guard on the item's own head commit. The existing move, delete and folder
services gained lock-free `…InRepo` variants
([`folders.ts`](../packages/core/src/services/folders.ts),
[`documents.ts`](../packages/core/src/services/documents.ts),
[`tables.ts`](../packages/core/src/services/tables.ts)) and kept their exported
wrappers unchanged, so the tRPC routers and the folder, document and table UI
are untouched. A folder's user-facing name and its create/update stamps
(`created`, `createdBy`, `updated`, `updatedBy`, like a document header) are
stored in
`<folder>/.folder.json` ([`folderMetadata.ts`](../packages/core/src/documents/folderMetadata.ts));
the directory name stays the slug, `folder.tree`/`tableFolder.tree` expose
`folderNames` and `folderStamps`, the explorer shows the stamps on folder rows,
[`upgradeFolderMetadata`](../packages/core/src/services/folderMetadataUpgrade.ts)
fills them from Git history for older folders in `system.reconcile`
(`Project.folderMetadataVersion`, migration `20261006090100`), and the shared explorer moves items into folders by drag and
drop through each adapter's `useMove`. The assistant panel is not: a lifecycle proposal is parsed by a
`lifecycle` arm in
[`proposalPreview.ts`](../apps/web/src/lib/assistant/proposalPreview.ts) and
rendered by
[`LifecyclePreview.tsx`](../apps/web/src/components/assistant/previews/LifecyclePreview.tsx),
which [`ProposalCard.tsx`](../apps/web/src/components/assistant/ProposalCard.tsx)
selects. `recoverPriorOperation` replays a lifecycle commit by its trailer when
the database acknowledgement was lost; that replay only reads history.
Separately, on the `content.restore` apply path, `ensureRecoveryFolder`
recreates the folder of a deleted item whose folder was removed with it, inside
the recovery commit itself. `aggregate_table` (design §8) computes count,
countNonEmpty, sum, avg, min, max and distinctCount over every row matching the
typed filters at one pinned snapshot, optionally grouped, with the group list
paged by a `groups` cursor. The typed query language moved from the tool adapter
into [`query.ts`](../packages/core/src/tables/query.ts) and the fold lives in
[`aggregate.ts`](../packages/core/src/tables/aggregate.ts); `tables.ts`
re-exports the query names so `queryRows` and its callers are unchanged. An
`aggregate` source locator records the normalized query for later
recomputation, while the citation it produces stays a table citation. Content
reads are
snapshot-pinned: [`contentSnapshots.ts`](../packages/core/src/services/contentSnapshots.ts)
resolves an optional `atCommitSha` against HEAD (`SNAPSHOT_UNAVAILABLE` on
anything unreachable), `getDocumentAtSnapshot`/`getTableAtSnapshot` return
`snapshotCommitSha` (project tree) and `baseCommitSha` (resource revision,
also `commitSha`), and [`contentCursors.ts`](../packages/core/src/services/contentCursors.ts)
signs continuation cursors bound to project, resource, snapshot, and normalized
query (`INVALID_CURSOR` on any mismatch; a bare row id is rejected, never
restarted). `list_table_columns`, `list_table_column_options`, and
`read_table_cell` complete wide schemas, long option lists, and strings over
2,000 characters that row pages list under `oversizedCells`.
[`prompt.ts`](../packages/ai/src/prompt.ts)
bounds history and reserves model context for instructions, tools, and output,
checking each tool-loop step before sending it to the provider. Retries are
Weaver run attempts (`failRunAttempt`), not pg-boss retries — the
`assistant.run` queue runs with `retryLimit: 0`; a worker shutdown abandons
its in-flight runs without marking them user-cancelled, and
`reconcileAssistantRuns` resolves runs whose lease expired from a lost worker.
It requeues only active runs below `maxAttempts`; otherwise it finalizes the
run as failed, or cancelled when cancellation was already pending.
That reconciliation has its own scheduled job, `assistant.reconcile`
(`WEAVER_ASSISTANT_RECONCILE_CRON`, every minute by default), rather than
riding the 15-minute `system.reconcile` cron: an attempt lease is 30 s and a
stranded run blocks its whole conversation — no new message, no delete —
until it is reconciled, which can take up to roughly 100 s worst case once
pg-boss's own cron and polling intervals stack on top of the one-minute
schedule. It is safe to run from several workers at once,
because expired attempts and requeued runs are both claimed with conditional
updates, including a fresh expiry check. Terminal transitions lock attempt then
run; an acknowledged cancellation prevents completion from inserting an answer. `assistant:use` is granted only to
browser-session actors, so API keys and OAuth tokens cannot drive the
internal assistant. Dependency direction is
`core ← assistant-tools ← ai ← agent-worker`; `apps/web/src` never imports
`@weaver/ai` (it is a devDependency there, used only by integration specs).

The panel consumes the `assistant` tRPC router and
`GET /api/assistant/runs/:id/events`, which replays persisted events after an
`after` cursor and polls for new ones roughly every second — PostgreSQL
`LISTEN/NOTIFY` is deferred to the Phase 4E panel, where the latency is
user-visible. When `?after=` is absent the route falls back to the standard
`Last-Event-ID` request header (so the browser's own `EventSource` reconnect
resumes correctly), and a mid-stream failure is framed as a `stream.error`
SSE event rather than `error`, because `EventSource` treats a same-named
`error` event as a transport failure and would retry instead of surfacing it.
Assistant proposals carry exactly one
operation in this phase (spec §15 allows "one or more"; `operation` is a JSON
column so `operations[]` is a later additive change): acceptance takes the
project lock, durably claims `accepting` before Git writes, verifies the base
revision, and commits once with both a
`Weaver-Operation-Id: proposal:<id>` and a `Weaver-Run-Id` commit trailer
(spec §15 audit metadata). Reject/expiry can recover a crashed acceptance after checking its operation trailer;
acceptance retries recover the original commit. Failed, cancelled, or superseded
attempts invalidate their pending proposals and cannot publish new ones. Create operations use stable
resource identities via [`contentOperations.ts`](../packages/core/src/services/contentOperations.ts).
SSE replay respects stream backpressure and its lifetime bound; the browser
retains completed live text until the persisted answer is observed. Reconnects and
reloads subscribe to the current run, and event replay rechecks scope membership.
`getConversation(beforePosition)` pages the newest 200 messages;
`getConversationStatus`, `getProposal`, and message-filtered `listCitations`
keep refreshes bounded; lightweight status polls
refresh proposals during a run. System reconciliation expires terminal event rows
only after both event creation and run completion are older than seven days;
assistant recovery does not maintain a separate pruning policy.
A settled failed or cancelled message carries
`MessageView.error: { code, message } | null`, read from the triggering run's
stored `errorCode`/`errorMessage` and visible only to the conversation's owner;
`ConversationSummary.lastRunStatus` reports the conversation's most recent run
regardless of activity, and `activeRun` derives from that same latest run
(`SUMMARY_INCLUDE` fetches the latest run, not only active ones). The Transcript
renders the stored error through `RunStateStrip`'s Details block with an admin
diagnostics link, and the conversation list marks a conversation whose last run
failed with a danger dot when no run is currently active.
Document/table focus is labelled as context within the authorized project scope.
Output/step limits are surfaced in the answer rather than silently truncating it.

## MCP runtime

Bearer checks join live enabled clients. `auth/oauthRevocation.ts` adds JTI,
consent-generation and refresh-family checks to introspection; `oauthConsentAdapter.ts`
serializes consent writes with user credential revocation and rechecks persisted
session/user state. Remote transfer destinations are built from the registered base URL.

`apps/mcp-server` serves protocol revision `2026-07-28` plus stateless
2025-era Streamable HTTP clients such as Codex
(`createMcpHandler(…, { legacy: "stateless" })`). Both use the same authenticated
per-request server factory. Legacy SSE responses are buffered until execution
finishes so audit outcomes and shutdown draining remain correct. JSON-RPC
batches are rejected; there are no sessions, prompts, or subscriptions. Public URLs come from
[`packages/config/src/publicUrls.ts`](../packages/config/src/publicUrls.ts):
resource `<AUTH_URL origin><base path>/api/mcp` (audience, endpoint path) and
issuer `<AUTH_URL origin><base path>/api/auth`; the web runtime's Better Auth
`baseURL` is that issuer, while its request adapter restores the base path
which Next strips before routing (spec §26.2 item 6). Explicit resource and
issuer overrides lose a non-root trailing slash, so the advertised audience,
metadata, consent resource, and accepted handler path remain identical.

Request pipeline
([`packages/mcp/src/http.ts`](../packages/mcp/src/http.ts)): request id →
Host/Origin validation → `405`/`415` → cheap admission → body cap (`413`) → bearer gate (`401` with
`WWW-Authenticate` naming the RFC 9728 document, `403 insufficient_scope`,
RFC 9449 `DPoP` challenge) → per-credential and per-client rate limits (`429`,
`Retry-After`) → the SDK handler. Missing and unrecognized credentials have
separate address budgets, so missing-credential traffic cannot exhaust new-client
admission. Admission remembers bounded, short-lived
credential hashes so recently verified clients sharing an address get a separate
budget; every request still revalidates authority. Access logs use recognized
body methods and registered contract names rather than routing-header values. Tools
([`tools.ts`](../packages/mcp/src/tools.ts)) run under
`WEAVER_MCP_TOOL_TIMEOUT_MS`, return serialize-then-parse JSON as
`structuredContent`, add `resource_link` items for citations, and report
failures as `isError` results with the `ToolError` codes. A folder named by a
write that does not exist is the one specific `NOT_FOUND` (reason
`FOLDER_NOT_FOUND`, from `folderNotFound` in `documents/paths.ts`); folders are
never created implicitly, as the server instructions state. An admitted write
may return `CANCELLED` only before its irreversible content-operation boundary;
after that boundary the adapter awaits and reports the real result. For an
authorized write call, the HTTP bridge passes the incoming abort to the tool
as a cooperative signal but shields the SDK transport from tearing down the
request independently; read calls retain normal transport cancellation. On
shutdown, the Node listener stops admission, drains active HTTP work, and only
then closes the SDK handler. The drain itself is correctness-first and has no
local timeout; the shared runtime lifecycle applies a process watchdog of
`WEAVER_MCP_TOOL_TIMEOUT_MS` plus 10 seconds and exits failed rather than fabricating a terminal cancellation.
Authenticated rate-limited tool/resource attempts receive one payload-free
`RATE_LIMITED` audit row; unauthenticated failures remain log-only. Resources
([`resources.ts`](../packages/mcp/src/resources.ts)) are
`weaver://projects/{projectId}/documents|tables|entities/{id}`; missing and
hidden both answer `-32602`. Document and table resources also accept
`/revisions/{commitSha}` and return `net.weaver/snapshotCommitSha`,
`net.weaver/baseCommitSha`, and `net.weaver/revisionUri` in `_meta`; the
table JSON names the complete-read tools under `completeReads`. Capped
table/entity resources remain valid JSON by returning an explicit truncated
envelope plus MCP truncation metadata.

Toolsets and meta-tools
([`packages/assistant-tools/src/toolsets.ts`](../packages/assistant-tools/src/toolsets.ts),
[`packages/mcp/src/metaTools.ts`](../packages/mcp/src/metaTools.ts),
[`instructions.ts`](../packages/mcp/src/instructions.ts)): `tools/list`
returns a curated core list by default (project, folder and document listing
and reading, hybrid search, entities, tables, file overviews, `create_document`,
`patch_document`; about 26 KB). The `X-Weaver-Toolsets` header adds named
toolsets to core (`documents`, `tables`, `files`, `graph`, `write`,
`connections`, `admin`, `external`, or `all`); unknown names are ignored.
Capability filtering runs after selection, so a toolset never grants a tool the
credential could not use. Connected-app tools (`ext_…`) are listed only with
`external`. Three meta-tools are always listed: `search_tools` finds a permitted
tool by task, `describe_tool` returns its input schema, and `call_tool` runs it;
their catalogue is `mcpToolsForActor(security)` plus the credential owner's
inbound external tools. `call_tool` keeps the inner tool's validation, write
shielding, audit row and `mcp.tool.called` diagnostic (inner name,
`details.via: "call_tool"`), also when the inner arguments are invalid. A
rate-limited `call_tool` is audited under the inner contract's name, but under
`call_tool` for an `ext_` tool, which is not fetched yet at that point.
Outcomes recorded under a meta-tool's own name emit `mcp.tool.called` with
`details.kind: "meta"`. An inner tool the caller may not use answers as unknown. A direct `tools/call` of a
permitted tool outside the listed set still works. Server instructions are
built per request from the selection.

Direct writes are the nine `write` contracts in
[`packages/assistant-tools/src/tools/writes.ts`](../packages/assistant-tools/src/tools/writes.ts)
(`MCP_TOOLS` = read + write; the assistant registry never sees them),
including `patch_document`, `change_table`, and `restore_content`. They call
[`applyMcpOperation`](../packages/core/src/services/mcpOperations.ts), which
shares [`applyOperationInRepo`](../packages/core/src/services/contentOperations.ts)
with `acceptProposal`, uses the independent bounded
`WEAVER_MCP_OPERATION_LOCK_POOL_MAX` pool, stores one `McpOperation` per `(userId, idempotencyKey)`
with a request hash, replays the stored result on retry, refuses key reuse with
a different request, and recovers an interrupted commit by its
`Weaver-Operation-Id: mcp:…` trailer only when the durable
`Weaver-MCP-Request-Hash` and `Weaver-MCP-Tool` trailers also match. Legacy or
mismatched operation-only commits fail closed as idempotency-key reuse. Every
`tools/call` and `resources/read` writes an `McpAuditEvent` (no payloads, no
tokens); the `system.reconcile` job prunes operations after 30 days and
audit rows after 90 in bounded batches for every worker role.

Consent management: `/account/connected-apps` lists and revokes
`OauthConsent` rows through
[`packages/core/src/services/oauthConsents.ts`](../packages/core/src/services/oauthConsents.ts);
a revoked consent stops its tokens on the next MCP request. The Phase 4F
generation cutover is deliberately fail-closed: its migration locks the OAuth
authority tables, rotates every existing consent generation, and revokes every
existing access and refresh token. If that cutover is pending on an existing
database, [`migrate-deploy.ts`](../packages/db/prisma/migrate-deploy.ts) first
takes a writer-conflicting `OauthConsent` relation lock, waits for a row-first
revocation to finish, verifies that no other database clients remain, and
hands the barrier to Prisma. Operators must stop web, worker, and MCP runtimes,
then apply all migrations before restarting them. Clients connected before the
upgrade must authorize again; personal API keys are unaffected.

An MCP request resolves one capability-neutral membership/restriction `all`
scope, capped at the 100 most recently updated accessible projects. Every tool
and resource still enforces its own read/write capability and the same capped
scope; `list_projects` reports scope truncation. Deferred from 4F (spec §26.3):
MCP proposal tools and the proposal inbox, and a bounded `resources/list`.

## Remote instances

Sending a document or table to another Weaver instance uses three models:
`RemoteInstance` (the registry: name, `baseUrl`, `enabled`, revision, Test
status), `RemoteInstanceConnection` (one user's encrypted tokens for one
remote, `@@unique([remoteInstanceId, userId])`), and
`RemoteInstanceAuthorization` (a 10-minute in-flight connect attempt). Service
code lives in `packages/core/src/services/remoteInstances/{registry,
connections,transfer,receive}.ts`: `registry.ts` holds Admin CRUD and Test,
`connections.ts` the OAuth connect/callback/refresh flow and
`withRemoteToken`, `transfer.ts` the sending side (`fetchTransferTargets`,
`fetchTransferTargetFolders`, `sendDocumentToRemote`, `sendTableToRemote`),
and `receive.ts` the caps and validation the receiving side applies. There is
no CIMD and no DPoP (design amendment): registering remote B on instance A
also creates B's OAuth client row on A directly, with client id
`weaver-instance:<B base URL>` (`remoteClientId` in
`packages/core/src/remotes/urls.ts`), a public PKCE client whose redirect URI
is `<B base URL>/api/remotes/callback`; both directions work once both Admins
have registered each other. Tokens are plain bearer tokens, encrypted at rest
with the same key ring as `ExternalMcpConnection`. `withRemoteToken` asks the
user to reconnect only when B refuses the token refresh (400/401); every other
refresh or request failure reaches `transfer.ts`'s `mapRemoteError`, which
reports B as unreachable or names B's status.

`GET /api/remotes/callback` completes the connect flow and upserts the
`RemoteInstanceConnection`. `GET/POST /api/transfer/*`
(`apps/web/src/app/api/transfer/`) are the receiving side: `whoami`,
`targets` (a user's Editor-or-better projects), `targets/{projectId}`
(that project's document and table folder trees), and `documents`/`tables`
(the writes). All of them resolve the bearer token exactly like the MCP
route (`resolveMcpPrincipal`) against the resource `<base URL>/api/mcp` —
transfer reuses the MCP audience rather than minting a new `OauthResource`,
so the consent screen shows "Weaver MCP". Endpoints are derived, not
discovered: issuer `<base URL>/api/auth`, authorize/token under
`<issuer>/oauth2/`, health `<base URL>/api/health`
(`remoteEndpoints` in `packages/core/src/remotes/urls.ts`).

Caps: the sender (`transfer.ts`) refuses to build a document's payload once
its images exceed 100 files or 46 MiB combined
(`TRANSFER_MAX_IMAGES`, `TRANSFER_MAX_IMAGE_BYTES_TOTAL`); the receiver
(`receive.ts`) independently enforces the 100-image count, each image's own
size against `WEAVER_DOCUMENT_IMAGE_MAX_BYTES`, and the whole request body
against 64 MiB (`TRANSFER_BODY_MAX_BYTES`, read by
`apps/web/src/server/transfer/body.ts`'s `readBoundedJson` before the JSON is
even parsed). The sender leaves out images whose file names the receiver
would refuse (`TRANSFER_IMAGE_NAME_RE`) and keeps their links. Cross-references
are rewritten to plain text before sending (`crossrefsToText`); document
transfers set the commit trailer `Weaver-Operation-Id:
remote-transfer:<sending instance base URL>` on B, derived from the token's
client id — `createTable` has no equivalent provenance parameter, so table
transfers carry no trailer. The item is created on B as the receiving user,
with no history. UI: `SendToRemoteDialog`
(`apps/web/src/app/(workspace)/projects/[projectId]/_components/SendToRemoteDialog.tsx`)
is opened from the document actions menu ("Send to another Weaver…") and
renders its own trigger in the table toolbar's `extraActions`/`compactExtraActions` slots (visible to
every role); it is hidden when no enabled remote exists.

## Diagnostics and admin MCP tools

[`packages/core/src/diagnostics/`](../packages/core/src/diagnostics/) owns the
event catalog, AsyncLocalStorage correlation, sanitizer, provider-fetch capture,
and process-local writer used by web, worker, and MCP. Tool schemas are converted
once per registered contract; HTTP authentication distinguishes infrastructure errors
from invalid credentials and pins JWT claims/algorithms. Explicit signed-token
revocations use expiry-bound `Verification` entries, and live refresh-family state
is checked alongside consent generation.
[`refresh-family revocation`](../packages/db/prisma/migrations/20260914000400_oauth_refresh_family_revocation/migration.sql)
invalidates the exact consent generation when the provider deletes an unexpired
refresh family, so reauthorization cannot revive older JWTs. Logging defaults to
`standard` (processing lifecycle metadata, warnings, and failures); `errors` keeps
only warnings/failures and `off` disables event capture. The typed `diagnostics` [`SystemSetting`](../packages/core/src/services/diagnosticsSettings.ts)
is refreshed at least every 15 seconds, while runtime startup waits at most one second for
the initial read. Authorization headers are excluded, and known request
credentials are scrubbed before persistence. Conversation, document, message, and prompt content may be retained
only in sanitized, Unicode-safe, bounded provider request/response body fields
at `verbose`; that content is excluded from every other field. Capture replaces
known request secrets before persistence; [`redactSecrets.ts`](../packages/core/src/security/redactSecrets.ts)
shares recognizable-format scrubbing with assistant failures. Pattern redaction
is a fallback for unknown secrets. Capture is skipped at `off`; verbose streaming
responses are parsed as bounded SSE frames with provider-timeout and shutdown
cancellation. Numeric usage counts remain visible. Body reads additionally require
current membership in the correlated project and every project recorded in the
event's immutable `bodyProjectIds`. Assistant capture unions the current scope
with all replayed message provenance; nested and bound diagnostic contexts cannot
narrow that union. Unknown provenance suppresses capture, and legacy run events
without provenance refuse body reads. Authorization remains valid after the run
or conversation is deleted. Unscoped worker bodies cannot be disclosed. The
nullable provenance field is added by
[`20260914113000_diagnostic_body_provenance`](../packages/db/prisma/migrations/20260914113000_diagnostic_body_provenance/migration.sql).

Jobs, committed knowledge transitions, provider calls, assistant attempts,
MCP/auth/tRPC boundaries, and setting changes emit catalogued events. A
routine `project.git-sync`, `task.tick`, or `assistant.reconcile` start/completion
uses debug severity; failures remain errors. The
[`routine job severity migration`](../packages/db/prisma/migrations/20260921001300_routine_job_diagnostic_severity/migration.sql)
reclassifies their existing informational lifecycle rows without deleting events.
A committed `assistant.attempt.cancelled` is distinct from an abandoned lease
whose requeue or terminal outcome reconciliation decides. MCP tool/resource
diagnostics share the audit claim, so each authenticated attempt has one owner
and one correlated outcome.

Every failure site emits an event whose `details.error` is a bounded, redacted
[`ErrorSummary`](../packages/core/src/diagnostics/errorSummary.ts) (name,
message, code, errno, syscall, hostname, three cause levels, five stack frames).
[`reference.ts`](../packages/core/src/diagnostics/reference.ts) derives an
eight-character reference from the event id; `captureError` emits immediately
and returns it, while `reserveDiagnosticEvent` hands out an id before a
transaction so the stored failure summary can end with ` (ref …)` and the
after-commit event reuses that id. Network causes are translated for users by
[`networkFailure.ts`](../packages/core/src/diagnostics/networkFailure.ts),
including the `OUTBOUND_NOT_ALLOWED` code thrown by the pinned outbound fetch.
Internal tRPC failures emit `trpc.error` and append the reference to the client
message. The Diagnostics page lists and opens events
(`diagnostics.listEvents` / `diagnostics.getEvent`); MCP
`list_diagnostic_events` and `get_diagnostic_event` accept a `reference`.
[`documentChangeSummaryInspection.ts`](../packages/core/src/services/documentChangeSummaryInspection.ts)
lists change summary rows as Admin-only metadata (status, reason, attempts,
last error class and job id, timestamps, per-status counts, project facets)
for `diagnostics.listChangeSummaries` and the MCP tool
`list_document_change_summaries`; it never returns summary text, paths, or
titles. Administration › Diagnostics shows them in a Change summaries card
(count chips, status and project filters, Previous/Next paging) whose Events
links open the Events panel filtered by `documentId` and `jobId` search
parameters.
[`processingInspection.ts`](../packages/core/src/services/processingInspection.ts)
adds Admin-only, bounded status pages for knowledge generations/documents, keyword
indexing, ingestion files, assistant runs, scheduled task runs, and queue deliveries.
The Diagnostics Processing card reads durable state independently of log level,
refreshes the first page, and links retained correlated events. It excludes source
content, filenames, prompts, and raw failure messages.
Run links retain all attempts; import links use indexed `details.fileId` across
parse, OCR, analysis, and linking jobs. Queue links select one delivery.
Suppressed external providers and the generic job runtime keep only their closed
classification, and an assistant or task run with external context omits the
summary, because those errors may carry private content.

[`diagnosticEvents.ts`](../packages/core/src/services/diagnosticEvents.ts)
provides filtered snapshot-cursor reads, Unicode-safe body pages, and retention
pruning. Prune batches serialize across processes with a PostgreSQL advisory
transaction lock, using a fixed overflow cutoff. Verbose body expiry clears body
fields while preserving standard request metadata until standard retention expires.
Pruning runs independently of other `system.reconcile` outcomes, even with logging
off. A short-lived aggregate cache serves statistics; each runtime publishes bounded
writer counters under `SystemSetting` for the administration page. The eight diagnostics contracts in
[`tools/admin/diagnostics.ts`](../packages/assistant-tools/src/tools/admin/diagnostics.ts)
are MCP-only and require `system:admin`; that capability is limited to current
global Admin sessions or explicitly granted personal keys and is never an OAuth
scope. The same services back the
[`diagnostics` tRPC router](../apps/web/src/server/api/routers/diagnostics.ts)
and [Administration › Diagnostics](<../apps/web/src/app/(workspace)/admin/diagnostics/>),
whose form preserves dirty edits and serializes save/prune actions.
The Events severity filter defaults to **Info and above**. Its `excludeDebug`
query filter runs before pagination; **Debug** and **All severities** remain
explicit choices. An exact severity takes precedence, while unfiltered service
and MCP reads continue to include every severity. Debug events remain eligible
for capture at Standard and Verbose logging levels.

[`retentionSettings.ts`](../packages/core/src/diagnostics/retentionSettings.ts)
defines the `retention` [`SystemSetting`](../packages/core/src/services/systemSettings.ts)
value (`ingestionDays` 1–365 default 30, `assistantConversationDays` 0–730
default 90 with 0 meaning keep every conversation, `taskRunDays` 1–365 default
30, `aiUsageDays` 1–730 default 90; a stored value that no longer validates
falls back to defaults rather than erroring).
[`services/retentionSettings.ts`](../packages/core/src/services/retentionSettings.ts)
exposes admin-only get/set under an advisory transaction lock and emits
`settings.changed` with the before/after values.
[`processingRetention.ts`](../packages/core/src/services/processingRetention.ts)
reads the settings once per pass and prunes AI usage, terminal task runs
(preserving the latest run and last successful baseline), finished ingestion
batches (every file accepted/rejected/failed, newest file update older than the
cutoff; cascades to `IngestionFile`/`IngestionDraft`, blobs swept separately by
ingestion storage cleanup), and idle assistant conversations (no active or
recent run, no pending/accepting proposal, no external MCP call/approval
evidence; skipped entirely when the setting is 0). Ingestion batches use the
pass batch size (≤5,000); idle conversations are additionally capped at
min(batch size, 1,000). Terminal
assistant events (7 days) and terminal assistant attempts (30 days) stay fixed
constants, not settings. All tables run in advisory-serialized batches;
retained external-call evidence, active work, and user content are kept.
pg-boss queue history expires after 7 days. MCP operation/audit cleanup keeps its
30/90-day policy with bounded batches. These jobs run on system reconciliation
regardless of worker roles or logging level. Individual failures identify their
housekeeping operation in Diagnostics while independent cleanup/recovery
finishes; `processing.history.pruned` details report every table's committed
count, including the ingestion-batch and conversation counts.

Administration › Diagnostics shows a Retention card
([`RetentionCard.tsx`](<../apps/web/src/app/(workspace)/admin/diagnostics/_components/RetentionCard.tsx>))
backed by the admin-only `diagnostics.getRetentionSettings`/`setRetentionSettings`
tRPC procedures; the Processing card's retention sentence reads the same live
settings instead of a hardcoded number. Admin MCP tools `get_retention_settings`
and `set_retention_settings` join the registry in
[`tools/admin/diagnostics.ts`](../packages/assistant-tools/src/tools/admin/diagnostics.ts).

**Retention** — every pruned table, its period, and where that period is set:

| Data                                                                                   | Period                   | Configured in                                                     |
| -------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------- |
| Diagnostic events                                                                      | per diagnostics settings | Administration › Diagnostics settings form                        |
| Background-work receipts                                                               | 14 days (fixed)          | `pruneBackgroundWorkReceipts`                                     |
| MCP operation records / audit rows                                                     | 30 / 90 days (fixed)     | `pruneMcpRecords`                                                 |
| External MCP call/approval metadata                                                    | 30 days (fixed)          | `reconcileExternalMcpState`                                       |
| AI usage, terminal task runs, finished ingestion batches, idle assistant conversations | retention settings       | Retention card, `get_retention_settings`/`set_retention_settings` |
| Terminal assistant events / attempts                                                   | 7 / 30 days (fixed)      | `processingRetention.ts` constants                                |
| Knowledge generations (superseded/stale)                                               | 7 days (fixed)           | `knowledgeGenerations.ts`                                         |
| Document change summaries (failed/skipped only)                                        | 30 days (fixed)          | `documentChangeSummaries.ts`                                      |
| pg-boss job/queue history                                                              | 7 days (fixed)           | pg-boss queue policy                                              |

The read-only insight contracts in [`tools/admin/`](../packages/assistant-tools/src/tools/admin/)
are registered only in `ADMIN_TOOLS`. Their core services are:

| Service                                                                                                                                        | MCP tools                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`adminOverview.ts`](../packages/core/src/services/adminOverview.ts)                                                                           | `admin_overview`, `admin_health`: allowlisted runtime facts, relation sizes, queue health, reconciliation and writer status                                                                                                      |
| [`queueInspection.ts`](../packages/core/src/services/queueInspection.ts)                                                                       | `list_queue_jobs`, `get_queue_job`, `queue_summary`: parameterized, read-only pg-boss inspection with missing-schema handling                                                                                                    |
| [`aiUsageQueries.ts`](../packages/core/src/services/aiUsageQueries.ts)                                                                         | `list_ai_usage`, `ai_usage_summary`: usage metadata and currency-separated totals with unpriced-call counts                                                                                                                      |
| [`llmConnections.ts`](../packages/core/src/services/llmConnections.ts), [`llmRoutes.ts`](../packages/core/src/services/llmRoutes.ts)           | `list_llm_connections`, `list_llm_models`, `list_llm_routes`: credential-free configuration                                                                                                                                      |
| [`knowledgeInspection.ts`](../packages/core/src/services/knowledgeInspection.ts), [`knowledge.ts`](../packages/core/src/services/knowledge.ts) | `list_knowledge_generations`, `list_generation_documents`, `get_knowledge_status`: scope plus project Maintainer checks                                                                                                          |
| [`ingestionInspection.ts`](../packages/core/src/services/ingestionInspection.ts)                                                               | `list_ingestion_batches`, `list_ingestion_files`, `get_ingestion_file`: import batch/file/draft inspection with scope plus project Maintainer checks                                                                             |
| [`scheduledTaskInspection.ts`](../packages/core/src/services/scheduledTaskInspection.ts)                                                       | `list_scheduled_tasks`, `get_scheduled_task`, `list_scheduled_task_runs`, `get_scheduled_task_run`: definitions and run diagnostics, with scope plus output-project Maintainer checks and source-project read checks for details |
| [`assistantInspection.ts`](../packages/core/src/services/assistantInspection.ts)                                                               | `list_assistant_runs`, `get_assistant_run`: metadata only (no provider error prose), with reduced event metadata                                                                                                                 |
| [`mcpAuditQueries.ts`](../packages/core/src/services/mcpAuditQueries.ts)                                                                       | `list_mcp_audit_events`: payload-free request metadata                                                                                                                                                                           |

[`adminPaging.ts`](../packages/core/src/services/adminPaging.ts) validates cursors;
[`tools/admin/paging.ts`](../packages/assistant-tools/src/tools/admin/paging.ts)
bounds list envelopes to 16,000 characters and continues from the last emitted
item. List limits default to 50 and cap at 200. Usage integers beyond JavaScript's
exact numeric range are returned as decimal strings. Runtime facts are supplied by
`apps/mcp-server` through the MCP context without environment secrets.
`adminInsight.spec.ts` and the MCP area suite cover the services and transport.

Scheduled task contracts live in
[`scheduledTaskRead.ts`](../packages/assistant-tools/src/tools/admin/scheduledTaskRead.ts).
Task lists filter by owner/status and support oldest/newest creation order; run
lists filter by status and inclusive queued-time bounds. Detail reads include all
stored definition/run fields, check current source membership and MCP scope, and
also check historical projects recorded in run heads/context. Small details return
`record`; oversized details return `record: null` and lossless `json` pages with
`offset`, `nextOffset`, `totalChars`, `revision`, and `truncated`. Concatenate pages
before parsing; `maxChars` forces paging. Continuations require the first page's
`revision` as `expectedRevision`; a changed record returns `CONFLICT` and the
caller restarts from offset 0. Use run/job IDs with the
existing diagnostic, usage and queue tools, and output IDs/SHAs with document reads.

The control contracts in [`llmWrite.ts`](../packages/assistant-tools/src/tools/admin/llmWrite.ts)
and [`knowledgeWrite.ts`](../packages/assistant-tools/src/tools/admin/knowledgeWrite.ts)
complete the admin registry. All mutations carry destructive MCP
annotations and await their actual result:

| Area               | Control tools                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Connections        | `create_llm_connection`, `update_llm_connection`, `delete_llm_connection`, `test_llm_connection`                   |
| Models and routing | `create_llm_model`, `update_llm_model`, `delete_llm_model`, `import_llm_models`, `test_llm_model`, `set_llm_route` |
| Knowledge          | `rebuild_knowledge_index`, `retry_failed_knowledge`, `enqueue_reconcile`                                           |

LLM contracts and tRPC share [`llmSchemas.ts`](../packages/core/src/services/llmSchemas.ts)
and the existing core administration services. `ToolContext.llm` carries the
server's encryption key ring and injected provider fetch. Credentials remain
write-only, and diagnostics record argument names only. Knowledge mutations
retain the UI's Maintainer and `content:write` checks after request-scope checks;
[`adminKnowledgeReconciliation.ts`](../packages/core/src/services/adminKnowledgeReconciliation.ts)
authorizes targeted and system-wide reconciliation before enqueueing.

## Local commands and test databases

| Command                   | Effect                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm dev`                | Start web, agent worker, and MCP server from `.env`                                         |
| `pnpm dev:web`            | Start only Next.js on `http://localhost:3000`                                               |
| `pnpm dev:worker`         | Start only the agent worker; health defaults to `127.0.0.1:3101/health`                     |
| `pnpm dev:mcp`            | Start only the MCP server; health defaults to `127.0.0.1:3200/health`                       |
| `pnpm check`              | Workspace lint, then TypeScript checks                                                      |
| `pnpm test`               | Script architecture/deployment checks and workspace unit tests                              |
| `pnpm build`              | Production web build                                                                        |
| `pnpm start`              | Run the built web app plus the agent worker and MCP server from `.env`                      |
| `pnpm start:web`          | Run only the built web app                                                                  |
| `pnpm start:worker`       | Run only the agent worker                                                                   |
| `pnpm start:mcp`          | Run only the MCP server                                                                     |
| `pnpm db:bootstrap-admin` | Create the first global Admin from `WEAVER_BOOTSTRAP_ADMIN_*` on an empty `weaver` database |

The destructive environment pairs remain exact and are enforced by
[`scripts/require-env.mjs`](../scripts/require-env.mjs), which wraps every
`db:*`, `test:integration*`, and `e2e` script: the env file must exist and
name the pair below, and a differing shell `DATABASE_URL`/`WEAVER_DATA_DIR`
aborts the command. Both destructive reset entry points also enforce the exact
database and resolved data path through
[`testEnvironment.ts`](../packages/config/src/testEnvironment.ts) before touching
PostgreSQL or files. Playwright prepares and seeds before starting the application
runtimes, each of which has exactly one owner.

| Database      | Data directory | Env file    | Commands                               |
| ------------- | -------------- | ----------- | -------------------------------------- |
| `weaver`      | `./data`       | `.env`      | development and `db:*`                 |
| `weaver_test` | `./data-test`  | `.env.test` | `test:integration`, `db:test:migrate`  |
| `weaver_e2e`  | `./data-e2e`   | `.env.e2e`  | `e2e`, `db:e2e:migrate`, `db:e2e:seed` |

Focused tests live under
[`apps/web/tests/integration/`](../apps/web/tests/integration/); browser tests
under [`apps/web/tests/e2e/`](../apps/web/tests/e2e/). Unit tests are colocated
throughout the apps and packages. Full integration and every Playwright run are
Tier 3 and require fresh user consent plus `RUN_FULL_TESTS=1`. See
[`docs/setup.md`](setup.md) and the
[`weaver-testing` skill](../.claude/skills/weaver-testing/SKILL.md).

## Deployment

Backup discovery includes restarting writers and checks for remaining running,
restarting or paused writers before dumping. CI reserves all `latest` image aliases
(including caches) for default-branch pipelines.

[`docker-compose.yml`](../docker-compose.yml) defines PostgreSQL, a one-shot
migrations service, a public web container, a private agent-worker container,
and the MCP container. All three runtimes use the same `web.env`, database,
`/data` bind mount, and source revision. Web and MCP join the external Traefik
network; the workers are internal-only and Compose checks their queue/database-aware
`/ready` probes on container port 3101.

[`docker/web.Dockerfile`](../docker/web.Dockerfile) builds the Next standalone
runtime and unprivileged migration tools target; build-only validation flags are
scoped to build commands. The tools target holds the workspace packages only;
the stage that copies the repository feeds the standalone build and is never
published, and [`.dockerignore`](../.dockerignore) keeps agent instructions,
`docs/` and `deploy/` out of every build context. Tini forwards signals to the full child process group.
Compose grants the worker 45 seconds and web/MCP 135 seconds to drain accepted work.
Production web startup preloads [`server-lifecycle.mjs`](../apps/web/server-lifecycle.mjs),
a version-checked private Next16 close adapter: native HTTP and `after()` draining
finishes before [`shutdown.ts`](../apps/web/src/server/runtime/shutdown.ts) closes the
publisher, diagnostic writer, and database. The development launcher also loads the
adapter and grants its child 25 seconds to exit (Next dev still force-closes active
requests by design). Each cleanup step is bounded and failures
do not skip subsequent steps; revalidate this adapter before upgrading Next.
[`docker/worker.Dockerfile`](../docker/worker.Dockerfile) contains only worker
runtime sources/dependencies and excludes tests. Compose structure is guarded
by [`scripts/compose-services.test.mjs`](../scripts/compose-services.test.mjs).
[`docker/mcp.Dockerfile`](../docker/mcp.Dockerfile) builds the MCP runtime the
same way as the worker. The `mcp-server` service joins both networks and shares
`web.env` and `/data`; Traefik routes `<base path>/api/mcp` and the exact
`/.well-known/oauth-protected-resource<base path>/api/mcp` path to it, and
`/.well-known/oauth-authorization-server<base path>/` (RFC 8414 discovery) to
web through an `addPrefix` middleware.
The Compose service sets `WEAVER_MCP_TRUST_PROXY=true` only because it has no
published port and public traffic crosses the controlled single Traefik hop;
the node adapter then trusts only Traefik's right-most appended
`X-Forwarded-For` address. Direct or differently proxied deployments must keep
the default `false` unless they provide the same boundary. This remains the
documented single-host deployment shape.

A host can be shared with other apps under `/weaver`. Compose reads its host, base path, Traefik network and certificate
resolver from `web.env` (`WEAVER_PUBLIC_HOST`, `WEAVER_BASE_PATH`,
`WEAVER_TRAEFIK_NETWORK`, `WEAVER_TLS_CERTRESOLVER`); no service needs a network beyond `internal` and Traefik's, and
[`createWeaverAuth`](../packages/auth/src/index.ts) names cookies `weaver.*`
scoped to the base path. [`deploy/`](../deploy/README.md) holds the runbook,
the `weaver-upgrade` (resolve `main`, strictly pull its SHA images, then verify the
exact deployed revision and healthy workers, and keep only the new and previous image
sets) and `weaver-compose-up`
(recreate application services while retaining PostgreSQL) helpers, the systemd stack unit and the daily quiesced
database + Git data backup (application services stopped during dump,
`git fsck` and archive).

The expensive-test hook delegates executable/assignment recognition to
[`test-command-policy.mjs`](../scripts/test-command-policy.mjs); comments,
quoted prose, and config-file reads do not count as tests or consent.

Runtime images share a world-readable Corepack cache, so the unprivileged user
can start pnpm offline. PostgreSQL reserves 150 connections; four Prisma pools
(10 each), two worker pg-boss pools (4 each), two publisher pools (2 each), and
four Git-lock pools (4 each) budget 68 connections. Backup, upgrade installation,
and service reload use the same `deploy.lock`; PostgreSQL has a 60-second stop
grace. CI refuses to overwrite immutable image tags, publishes cache aliases only
from the default branch, and executes the Next lifecycle preload as a smoke test.
The web smoke test also launches Chromium through the traced `playwright-core`,
which needs `browsers.json` from `outputFileTracingIncludes` in `next.config.ts`
(named by the package's real pnpm path), and checks the Mermaid bundle the PDF
export reads from `apps/web/node_modules/mermaid/dist/`.
[`upgrade-behavior.test.mjs`](../scripts/upgrade-behavior.test.mjs) covers strict
pull, revision mismatch, unhealthy workers, and successful pinned deployment.

## Versioning

The version authority is root [`package.json`](../package.json) and is served
by [`/api/health`](../apps/web/src/app/api/health/route.ts) through
[`appVersion.ts`](../apps/web/src/lib/appVersion.ts). Bump the root patch
version before every push to `origin`, not for local documentation commits.

[`next.config.ts`](../apps/web/next.config.ts) inlines that version, the build
time (`APP_BUILD_TIME`, else the moment of the build) and the commit
(`APP_COMMIT_SHA`) as `NEXT_PUBLIC_APP_VERSION` / `NEXT_PUBLIC_BUILD_TIME` /
`NEXT_PUBLIC_COMMIT_SHA`. Browser code reads them through
[`buildInfo.ts`](../apps/web/src/lib/buildInfo.ts) — never through
`appVersion.ts`, which imports `package.json` and belongs to the server — and
[`AppVersionFooter`](<../apps/web/src/app/(workspace)/_components/AppVersionFooter.tsx>)
renders build and timestamp at the bottom of the sidebar (version only in the
collapsed rail, with the timestamp and commit in its tooltip).
GitLab CI ([`.gitlab-ci.yml`](../.gitlab-ci.yml),
[`deploy/ci/build-images.sh`](../deploy/ci/build-images.sh)) stamps
`APP_COMMIT_SHA`/`APP_BUILD_TIME` and pushes `tools`, `web`, `worker` and
`mcp` to the project registry; [`docker-compose.yml`](../docker-compose.yml)
pulls them through `WEAVER_IMAGE_PREFIX`/`WEAVER_IMAGE_TAG`, and
[`docker-compose.build.yml`](../docker-compose.build.yml) adds the local
builds.

### Assistant external controls (Phase 7A)

There is no per-message selection. When the owner has an enabled connection, the
runner lists the available tools, registers all of them and exposes only native tools,
`find_external_tools` and loaded tools through `prepareStep.activeTools`
([`externalTools.ts`](../packages/ai/src/externalTools.ts),
[`externalToolSearch.ts`](../packages/ai/src/externalToolSearch.ts)). Loaded schemas
are charged against a reserve of `min(32 KiB, contextWindow / 8)`; history outside the
scope or a window too small for the reserve runs without external tools.
[`ExternalToolApprovalCard`](../apps/web/src/components/assistant/ExternalToolApprovalCard.tsx)
loads owner-authorized argument detail by persisted approval ID. Transcript restores
current-run approvals with `listApprovals`, independently of SSE retention, and
[`ExternalSources`](../apps/web/src/components/assistant/ExternalSources.tsx) renders
stored provenance separately from Git citations without remote resource loading.

[`ExternalRunActivity`](../apps/web/src/components/assistant/ExternalRunActivity.tsx)
restores completed/failed/cancelled call outcomes from `externalMcp.listCalls` and
reconciles live events with authoritative terminal metadata. The bounded owner,
session and full-scope-authorized read lives in
[`activity.ts`](../packages/core/src/services/externalMcp/activity.ts); existing
30-day call retention applies independently of SSE cleanup. Snapshotted connection
identity and byte-count summaries contain no raw arguments/results. Native messages
skip the additional read. Dispatch emits running activity after admission; recovery
writes matching unknown activity before the terminal run event.

[`external diagnostics`](../packages/core/src/services/externalMcp/diagnostics.ts)
queues narrowly allowlisted transitions until the enclosing transaction commits,
including approval invalidation and worker settlement; failed discovery has its own
committed outcome event. [`safe errors`](../packages/core/src/externalMcp/errors.ts)
share actionable cause codes across transport, core and task history while keeping
unknown remote certainty and no-replay evidence independent of the cause.

## Full application review fixes (2026-09-11)

The main runtime boundaries now include:

- [tRPC transport](../apps/web/src/server/api/http-transport.ts): same-origin
  JSON POSTs, 16 MiB streamed body limit and 20-procedure batches. Document
  validation checks bytes, depth, nodes and references before ProseMirror.
- [Outbound fetch](../packages/config/src/outboundFetch.ts): validated DNS
  answers and per-request address pinning; public HTTPS by default, explicit
  trusted origins for private/HTTP LLM, Docling and external MCP services.
  Connection destination changes require credential re-entry.
- Admin membership rescue uses the ordinary membership transaction lock and
  last-Owner guard. Global role and ban writes share the roster transaction.
  Consent display verifies the OAuth signature; SSE periodically verifies its
  session and bounds concurrent streams. Public health returns status/version.
- Git writers sanitize control characters and bound local subprocess time.
  Document/table restore and table delete require expected head tokens;
  table history offsets and immutable blob lookup caching are bounded. Git
  remote settings display the pinned SSH fingerprint and distinguish timeout.
- Knowledge generations can finish with terminal document/provider failures;
  retries are capped per document SHA and explicit retry, stale chunks and
  embeddings are pruned, semantic readiness is independent of extraction,
  and knowledge writes use explicit transaction budgets. Queue payloads are
  validated before dispatch.
- Assistant usage is accumulated per completed step and persisted per attempt.
  Automatic proposal application is confined to the pinned/single project;
  previews require current access. Routed assistant models require a known
  context window. Document backlinks use bounded keyset pages. Task definition
  edits belong to the owner;
  lost access permits cleanup, deleted projects pause tasks, and abandoned
  workers neither trigger failure auto-pause nor publish under expired leases.
- [UploadRateLimit](../packages/core/src/ingestion/rateLimit.ts) provides
  atomic per-user/channel minute windows across processes. Upload storage has
  project quotas and a free-space floor; native parsers run separately with
  memory/time limits and office archives receive expansion checks. Docling
  response bodies are counted while streaming.
- Prisma sessions use UTC. Forward migrations
  `20260921000900_review_integrity_indexes` and
  `20260921001000_upload_rate_limits` align defaults, add the missing FK
  indexes and store upload counters. Historical applied SQL remains immutable.
- Worker `/ready` probes the queue database with a bounded timeout, while
  `/health` remains liveness. Compose pins production mode and sets HSTS;
  production requires AUTH_URL. See [setup](setup.md#review-hardening-deployment-settings)
  for outbound origins, upload quotas and local test-host constraints.

## Implementation status

| Phase | Area                                                                                                                                                                                                                       | Status                                                         |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 0     | Bootstrap, auth, projects/members, shell, tests, deployment parity                                                                                                                                                         | **done**                                                       |
| 1     | Git-backed documents, rich editing, references, history/diff/restore                                                                                                                                                       | **done**                                                       |
| 2     | Git-backed typed tables and complete workspace                                                                                                                                                                             | **done**                                                       |
| 3     | Knowledge index, semantic search, graph/provenance, operations UI                                                                                                                                                          | **done**; community-summary evaluation is separate             |
| 4A    | Workspace/package extraction, separate knowledge worker, cross-process Git safety, two-runtime deployment                                                                                                                  | **implemented; Tier 3 verified; final-review repairs current** |
| 4B    | Better Auth, organizations, `SecurityContext`, personal keys, MCP OAuth foundation                                                                                                                                         | **implemented; Tier 3 verified**                               |
| 4B-2  | Personal API keys, MCP OAuth 2.1 foundation (JWT/JWKS/CIMD), first-user bootstrap                                                                                                                                          | **implemented; Tier 3 verified**                               |
| 4C    | Encrypted LLM connections, models, purpose routes, knowledge pipeline on routes, Admin › AI                                                                                                                                | **implemented; Tier 3 verified**                               |
| 4D    | Assistant persistence, worker execution, shared tools, citations, proposals, tRPC/SSE                                                                                                                                      | **implemented; Tier 3 verified**                               |
| 4E    | Assistant panel and full-page route, scope selector, streaming/reconnect/cancel, citation and proposal cards                                                                                                               | **implemented; Tier 3 verified**                               |
| 4F    | Standalone MCP runtime                                                                                                                                                                                                     | **implemented; Tier 3 verified**                               |
| 5A    | Project uploads, content-addressed originals, parse jobs, draft/status persistence, Imports UI                                                                                                                             | **implemented**                                                |
| 5B    | Native Word/Excel/CSV/PDF/image parsers, Docling adapter, OCR over the `ingestion` route, role-gated workers                                                                                                               | **implemented**                                                |
| 5C    | Analysis and linking stages, draft review, accept as one Git commit, reject, stage-aware retry/recovery                                                                                                                    | **implemented**                                                |
| 5D    | External feed endpoint for API keys, `ingest:external` capability, key-management UI, documentation                                                                                                                        | **implemented**                                                |
| 7     | Global user management (pulled forward, ahead of Phase 6): Admin-created accounts with forced first password change, role/status/password/session administration, project-membership editing, Account › Password           | **implemented**                                                |
| 6A    | Scheduled AI tasks: owner + scope + output project model, preset schedules, minute tick, prepared-context runs on the jobs route, living output document with provenance, run history, Project › Tasks and Account › Tasks | **implemented**                                                |
| 6B    | Background-work bell, tray and history; permission-aware task/import/assistant/knowledge read model; durable personal completion receipts                                                                                  | **implemented**                                                |
| 6C    | Project › Activity: latest activity, active-work preview, shared content pins and scoped report shortcuts; fresh assistant entry                                                                                           | **implemented**                                                |
| Exams | Training roles, PostgreSQL exam definitions and timed attempts, reviewed grading and release, personal notifications, MCP and assistant trainer tools                                                                      | **implemented**                                                |
| 7A    | Generic outbound MCP connections, reviewed project grants, assistant approvals and external report inputs                                                                                                                  | **shipped; Tier 3 verified**                                   |
| 7     | Remaining scope: native external data sources, statistics, backup/restore, export, memory graphs and global user API-key administration                                                                                    | planned                                                        |

Phase 7A shipped in 0.1.58. Administration ›
Connections managed discovery/review/grants (connections are personal since 0.1.156); the assistant explicitly selects tools
and resolves durable approvals; Project and Account task editors configure required
automatic read inputs. Native data-source adapters remain later Phase 7 work.
Acceptance covered all nine external MCP browser cases and six related assistant,
task and background-work cases.

The [synthetic MCP fixture](../apps/web/tests/e2e/mock-mcp-server.mjs) and
[browser acceptance](../apps/web/tests/e2e/external-mcp.spec.ts) exercise actual
counter side effects, approval drift, unknown outcomes and report preservation.
Playwright owns the loopback fixture alongside the mock AI and isolated e2e runtimes;
[root fixture tests](../scripts/mock-mcp-server.test.mjs) run without a browser.

Project Git remote synchronization ships in 0.1.65 as an additional project feature.
Owners can configure automatic one-way history pushes and manage encrypted SSH keys.

Document image attachments closed the Phase 1 deferral. All five content-tools slices have shipped.

The project artifact store's slice 1 (plain Files: upload, download, rename,
delete, sharing Imports' blob store and quota) ships in 0.1.107; slice 2
(`@weaver/artifact-readers`, a pure leaf package of Word/Excel/PDF/JSON
readers and the shared archive guard — no tools wired to it yet) ships in
0.1.108; slice 3 (the nine artifact-reading tools for the assistant/MCP,
each reader call isolated in a forked child process) ships in 0.1.109; see
[Artifacts (Files)](#artifacts-files) above.
All three slices of that design have shipped; open follow-ups (a manual
check against real Word/Excel/PDF files, artifact citations, parsed-structure
caching) are tracked in the `weaver-artifacts` skill.

OneNote assistant/MCP reading ships in 0.1.111, with a Rust parser and a durable
read cache validated against the supplied real notebook. It does not add an
import workflow; agents use the existing content tools to create documents.

Expanded read-only file tools ship in 0.1.184: TXT/Markdown, original CSV, safe YAML
queries and nested JSON/YAML inspection share the isolated gateway and bounded
continuations. See [Artifacts (Files)](#artifacts-files).

### Deferred: large-table storage and synchronization

Phase 7 was prioritized before large-table PostgreSQL-truth
storage and outbox synchronization. This remaining Phase 6 scope (provisionally
“6D”) is deferred until after Phase 7; it has no approved design or implementation
plan. Existing Git-backed table limits remain unchanged.

Machine content authors use `services/contentAuthor.ts` and trusted `Weaver-Project-Key-Id` trailers. Document/table projections store captured machine names separately from user foreign keys; history and dashboard activity preserve them after rebuild. `projectApi/snapshots.ts` resolves committed resource UUIDs without requiring a membership or projection.

Project machine read authority is isolated in `projectApi/policy.ts` and `queries.ts`: current live grants resolve against committed UUIDs under a shared repository lock. `cursors.ts` signs key/policy/query/HEAD-bound pagination. HEAD serves revisions independently of Read.

`services/projectApi.ts` exposes machine publishing. `projectApi/changes.ts` derives actions from prospective table deltas; `operations.ts` reserves generated UUIDs and authorizing anchors before shared Git writers, checks strong resource revisions, and settles metadata-only receipts. Recovery checks trusted key/operation/hash/kind trailers and resource identity. Separate `operationLock.ts` pool (`WEAVER_PROJECT_API_OPERATION_LOCK_POOL_MAX`, default 2) precedes the project lock.

The versioned REST adapter is `apps/web/src/server/projectApi/{body,respond,dispatch}.ts`, with thin Next handlers below `app/api/v1/projects/[projectId]`. `projectApi/contracts.ts` owns all 17 route descriptors and response/request schemas. Generate or check `docs/api/project-machine-api.openapi.json` via `packages/core/scripts/generateProjectApiOpenApi.ts`; authenticated responses are no-store and body decoding is bounded and fatal on malformed UTF-8.

Project key administration lives in [`services/projectApiKeys.ts`](../packages/core/src/services/projectApiKeys.ts) behind the session-only `projectApiKey` router (`list`, `create`, `update`, `revoke`, `targets`, `configuration`, `unresolvedOperations`). Every call requires a signed-in session with Maintainer membership and `content:write`; global Admin alone is not enough. Policy writes take the project repository lock, then `lockProjectMembershipWrites`, and recheck the role inside that transaction. They merge duplicate targets, keep unavailable existing grants and replace the policy atomically with a new version; the secret is returned only by `create`. Granting a legacy folder by path assigns its identity in that same transaction, and the `targets` picker is read-only and paged against one HEAD. `softDeleteProject` and the personal-workspace orphan cleanup also take the project lock, so they serialize with machine commits.

Project › Settings mounts [`MachineApiKeysCard.tsx`](<../apps/web/src/app/(workspace)/projects/[projectId]/settings/_components/MachineApiKeysCard.tsx>) only for Maintainers and Owners. It lists keys, their effective grants and unconfirmed writes, and hosts the create/edit dialog (`MachineApiKeyDialog.tsx` with the `MachineGrantFields.tsx` target picker), the revoke confirmation and the one-time `MachineKeySecretDialog.tsx`. Copyable curl/Python examples come from [`lib/project-api/examples.ts`](../apps/web/src/lib/project-api/examples.ts), using the configured public URL and base path.

[`projectApi/audit.ts`](../packages/core/src/projectApi/audit.ts) records one strict, metadata-only `ProjectApiAuditEvent` per authenticated request from the dispatcher. Requests rejected before authentication emit the `project_api.request.rejected` diagnostic without a key identity, and audit failures emit `project_api.audit.failed` without changing the response. A commit whose receipt cannot be settled raises `RECEIPT_PENDING` carrying the operation, resource and commit, and a retry recovers it. [`projectApi/retention.ts`](../packages/core/src/projectApi/retention.ts) runs as the `project_api_records` step of every worker's `system.reconcile`. It deletes succeeded or failed receipts after 30 days, audits after 90 days and stale rate windows, at most 5,000 rows per table per run, using `SKIP LOCKED` and a non-blocking advisory lock; reserved operations are never pruned. Client usage: [`docs/api/project-machine-api.md`](api/project-machine-api.md).

Project API recovery reconciles the affected resource against current Git state before
settling a recovered receipt: live document/table projections are repaired and queued
for indexing, and deleted projections are removed. Table repair uses the strict
`repairTableProjectionInRepo(..., { throwOnError: true })` mode so failed repairs leave
the reservation retryable. Publishing checks the base action using committed resource
and folder identities before loading rows or validating deltas, then checks all derived
actions. Generated publishing examples persist payloads and ETags locally under
`.weaver-requests`, keyed by the operation ID.
