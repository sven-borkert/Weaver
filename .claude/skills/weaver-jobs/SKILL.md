---
name: weaver-jobs
description: Use when changing Weaver background-job ownership, web publishing and worker consumers, pg-boss runtime/leases/recovery, scheduled reconciliation, background-work visibility/receipts, or durable Git push/pull jobs. Dashboard read models are covered by weaver-dashboard.
---

# Weaver Jobs

Durable background jobs run through one publishing boundary: web services publish through
`packages/core/src/jobs/publisher.ts`, and the separate agent worker registers
consumers and scheduled reconciliation through
`packages/core/src/jobs/runtime.ts`. Both construct their queue via
`packages/core/src/jobs/knowledgeQueue.ts`: the publisher in send-only mode
(no supervision/scheduling/enrichment migration), the worker in worker mode.
The running worker registers its queue as the process publisher immediately after
queue startup, before registering handlers (`setProcessJobQueue`), so handler follow-up enqueues reuse it instead of
lazily starting a second pg-boss instance; enqueues that land during the
worker's graceful drain fall back to the publisher, which `stopKnowledgeWorkers`
closes after the queue has stopped; once that stop completes, `requestKnowledgeJob`
throws (`setProcessJobsStopped`) until the runtime starts again, so nothing
boots an unmanaged pg-boss instance. Stop cleanup must publish the stopped
state and close the publisher even when `queue.stop()` rejects. The worker
lifecycle drains the queue before disconnecting Prisma. `PgBossQueue` logs pg-boss `'error'`
events instead of letting them crash the process, and the worker lifecycle
forces exit if shutdown outlives `shutdownTimeoutMs`. Keep that
web-publisher/worker-consumer ownership split and use weaver-knowledge-graph
for payload, generation, retry, and reconciliation invariants.
`document.change-summary` uses a short-policy queue keyed by project and
commit, `retryLimit: 2` with 30-second backoff, and `system.reconcile`
recovery plus 30-day pruning of failed/skipped rows (ready rows are kept).

`registerKnowledgeJobHandlers` wraps every delivery in diagnostic context and
emits `job.started` plus one terminal `job.completed`/`job.failed` event.
Start/completion for `project.git-sync`, `task.tick`, and `assistant.reconcile`
use debug severity; other jobs keep info and every failure keeps error severity.
`JobExecution.retryCount` is nullable because not every queue can report it.
Knowledge transition events are emitted only after their conditional database
write commits, and reconciliation reports accepted enqueue results rather than
attempts. `system.reconcile` uses pg-boss `retryLimit: 0` and runs knowledge reconciliation, diagnostic pruning,
receipt pruning and ingestion maintenance through `Promise.allSettled`; failures
do not skip other housekeeping. Diagnostic pruning is serialized across processes by
the diagnostic service's PostgreSQL advisory transaction lock.

`services/processingRetention.ts` supplies `pruneProcessingHistory` to the same
failure-isolated housekeeping pass. It reads `getRetentionSettings` (the
`retention` `SystemSetting`, see `weaver-diagnostics`) once per call and prunes,
at up to 5,000 rows per table: AI usage after `aiUsageDays` (default 90),
terminal scheduled-task runs after `taskRunDays` (default 30), finished
ingestion batches after `ingestionDays` (default 30, every file
accepted/rejected/failed, cascading to `IngestionFile`/`IngestionDraft`), and
idle assistant conversations after `assistantConversationDays` (default 90,
0 = keep forever) — ingestion batches use the pass batch size (≤5,000); idle
conversations are additionally capped at min(batch size, 1,000). Terminal
assistant events (7 days) and terminal assistant attempts (30 days) remain
fixed constants, not settings. The newest task run and latest successful
baseline remain, including tied baseline timestamps. Active parents/attempts
and any task run or attempt still linked to external calls/approvals remain
protected; an idle conversation is skipped while it has an active/recent run,
a pending/accepting proposal, or external MCP call/approval evidence. Event
batches drain before their attempt is removed, avoiding unbounded cascading
updates. External housekeeping owns those records' retention. Task output
documents, drafts, and current indexes are preserved regardless of
conversation/batch pruning. A nonblocking advisory transaction lock serializes
cleanup across workers; `processing.history.pruned` records only committed
per-table counts, including the ingestion-batch and conversation counts.
Pg-boss terminal history explicitly expires after seven days; existing worker
queues receive mutable retention/retry settings without resending the
immutable queue policy to `updateQueue`.

`pruneMcpRecords` and `pruneProjectApiRecords` (`projectApi/retention.ts`: 30-day receipts, 90-day audits, stale rate windows, 5,000-row batches, reservations kept) also run under `system.reconcile` for every worker role. A
nonblocking advisory transaction lock permits one cleanup pass, deleting at most
5,000 oldest rows per table: successful MCP operation receipts after 30 days and
MCP audit rows after 90 days. Locked rows are skipped, retention boundaries are
UTC, and `mcp.records.pruned` reports committed counts only.

`registerKnowledgeJobHandlers` role-gates consumer registration by
`WEAVER_WORKER_ROLES` (`packages/config/src/workerRoles.ts`): `knowledge`
gates the six knowledge-only consumers, `assistant` gates `assistant.run` and
`assistant.reconcile`, `ingestion` gates `ingestion.parse`,
`ingestion.analyze`, and `ingestion.link`, and `tasks` gates `task.tick`
(scheduled by `WEAVER_TASK_TICK_CRON`, only under this role) and `task.run`. The `git` role gates `project.git-sync` (minute discovery),
`project.git-push` (leased remote push) and `project.git-pull` (leased pull of
existing remote content, `retryLimit: 0`).
`system.reconcile`
is registered and scheduled by every worker regardless of role, because it
also drives ingestion storage sweep/recovery — see `weaver-ingestion`. When
`ingestion` is enabled but no `ingestionParseRunner` is injected, no
consumer is registered at all: this worker logs one startup warning per missing
stage runner and each job stays queued for another worker to claim. That is not
the same as `assistant.run` without a runner — that consumer is always
registered when `assistant` is enabled, and the missing-runner check lives
inside the handler, so each delivered run is acked and silently dropped with
a per-job warning instead of being left for another worker.

`assistant.run` (Phase 4D) is a durable job created with `retryLimit: 0`
(`packages/core/src/jobs/pgBossQueue.ts`); retryability is decided at the
Weaver level, not pg-boss's — `failRunAttempt`
(`packages/core/src/services/assistantRuns.ts`) classifies a failed attempt
as retryable or terminal and republishes the run itself when it retries. A
native proposal in `accepting` or `accepted` suppresses automatic provider and
lease-recovery retries (`CONTENT_CHANGE_APPLIED`) so the original request cannot
duplicate a committed change. Its proposal remains available for inspection or
acceptance recovery, including on failed/cancelled conversations. A
worker that loses its lease (crash, forced shutdown) leaves an orphaned run;
`reconcileAssistantRuns` recovers it from the `assistant.reconcile` cron job
(`WEAVER_ASSISTANT_RECONCILE_CRON`, default `* * * * *`), which is deliberately
separate from the 15-minute `system.reconcile`: the attempt lease is 30 s and a
stranded run blocks its conversation until it is reconciled. Both scheduled
names live in `SCHEDULED_JOB_NAMES` (`packages/core/src/jobs/types.ts`).
`assistant.run` carries no pg-boss singleton key — the queue policy is
`standard`, where the key is ignored; duplicate deliveries are harmless because
`leaseRunAttempt` claims the run with `where: { status: "queued" }`.
`startKnowledgeWorkers({ assistantRunner, ingestionParseRunner, ingestionAnalyzeRunner, ingestionLinkRunner })`
(`packages/core/src/jobs/runtime.ts`) is the only registration point —
`apps/agent-worker` passes `createAssistantRunner(...)` from `@weaver/ai` and
the ingestion stage runners from `@weaver/ingestion` as those options; there is
no second worker entry point for these jobs. The compose
deployment runs two containers from the same worker image:
`agent-worker` (`WEAVER_WORKER_ROLES=knowledge,assistant,tasks,git`) and
`ingestion-worker` (`WEAVER_WORKER_ROLES=ingestion`, its own health port
3102), so a slow OCR call cannot starve assistant runs. See `weaver-assistant`
for the run/attempt/event model, `@weaver/ai`'s runner, and `weaver-ingestion`
for the parse-stage runner.

User-authored scheduled tasks are implemented (Phase 6A) — see
`weaver-scheduled-tasks` for the `ScheduledTask`/`ScheduledTaskRun` model, the
minute tick, the `@weaver/ai` task runner, and the Project › Tasks/Account ›
Tasks UI. Phase 6B implements the shell jobs bell, tray and Account › Background
work through `services/backgroundWork.ts`. Phase 6C composes recent results through `services/dashboard.ts`. Keyword validation/source failures remain
terminal until the document changes or a Maintainer explicitly retries them.
Generation recovery uses typed failure classification in `knowledgeGenerations.ts`;
keep that distinction when expanding job operations.

Dashboard composition, report shortcuts and pin admission use `weaver-dashboard`; project lifecycle uses `weaver-projects`; low-level repository locking uses `weaver-git-store`. Job claims, consumers and receipts remain here.

## Job inventory

Canonical payloads and queue names live in `packages/core/src/jobs/types.ts`;
`jobs/systemContext.ts` separates worker authority from user actors.

| Job                                         | Handler owner                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `document.search-sync`, `table.search-sync` | `services/keywordIndex.ts`                                                                       |
| `document.ai-enrich`                        | `services/knowledgeGenerations.ts`                                                               |
| `document.change-summary`                   | `services/documentChangeSummaries.ts`                                                            |
| `content.delete`                            | `services/knowledgeGenerations.ts`                                                               |
| `project.reconcile`                         | `services/knowledgeReconciliation.ts`                                                            |
| `project.generation-build`                  | `services/knowledgeGenerations.ts`                                                               |
| `system.reconcile`                          | `jobs/runtime.ts`: knowledge repair, ingestion storage/recovery, diagnostics and receipt pruning |
| `assistant.run`                             | injected `@weaver/ai` runner                                                                     |
| `assistant.reconcile`                       | `services/assistantRuns.ts`                                                                      |
| `ingestion.parse`                           | injected `@weaver/ingestion` runner (`createIngestionParseRunner`)                               |
| `ingestion.analyze`                         | injected `@weaver/ingestion` runner (`createIngestionAnalyzeRunner`)                             |
| `ingestion.link`                            | injected `@weaver/ingestion` runner (`createIngestionLinkRunner`)                                |
| `task.tick`                                 | `scheduledTasks/tick.ts`                                                                         |
| `task.run`                                  | injected `@weaver/ai` runner (`createScheduledTaskRunner`)                                       |

Ingestion storage cleanup and database recovery are failure-isolated. Each pass
continues across project/file failures before reporting an aggregate error. See
`weaver-ingestion` for the attempt fence and publication recovery contract.
Ingestion parse/analyze/link also use short-policy queues, keyed by stage, file,
digest, and base attempt, so recovery under backlog cannot queue duplicates.
`project.reconcile` and `document.search-sync` use short-policy queues and canonical
singleton keys; cancelled reconciliation checks its signal at page boundaries.
Enrichment uses a 24-hour lease (the pg-boss maximum) and a 23-hour provider-call deadline;
queued retry/expiry drift is updated without rewriting active leases.

Enrichment claims persist a random `processingClaimToken` plus queue job/retry
identity. A newer retry of the same job can immediately replace an interrupted
claim; equal, older, unrelated, and unidentified deliveries wait for ordinary
recovery. Embedding, graph, and terminal state publication all match the claim
token; an old worker cannot publish after replacement. Cancellation conditionally
returns its own claim to pending. Recovery and committed cancellation emit
`knowledge.document.recovered` / `knowledge.document.cancelled`. Legacy claims
without delivery identity retain the 24-hour recovery window; never guess that
an unidentified worker is gone. Configuration blocking of a current document
terminates a building generation through activation/reconciliation while keeping
the previous active generation. Generation retention deletes at most 200 expired
generations per project/pass, preserves the newest superseded fallback, and emits
the committed `knowledge.generations.pruned` count.

`project.git-sync`, `project.git-push` and `project.git-pull` are owned by
`services/projectGitRemoteJobs.ts`; see Project Git push and pull jobs below.

## Background-work visibility

`services/backgroundWork.ts` owns session-only `content:read` list/summary/markSeen;
`services/backgroundWork/` normalizes existing task/import/assistant/knowledge/notebook/Git-sync rows
without copying execution state or consulting pg-boss/diagnostics. Authorization
precedes limits/counts: My work is owned + readable, Project work requires Maintainer
for shared tasks/imports/knowledge. Assistant runs always remain owned and require
`assistant:use` plus current access to every valid snapshot project. Admin never
bypasses membership. Explicit project filters use `assertProjectRole`.

Browser contracts live in zod-only `jobs/backgroundWorkSchema.ts`. Completed results
span seven days; active work has no age cutoff. Lists default to 20/max50 and use
signed actor/filter-bound keyset cursors; summary counts saturate at 100. The
`BackgroundWorkReceipt` key includes user, kind, workId and result revision.
`markSeen` matches at most 50 exact personal current terminal revisions in one SQL
statement. Import ready/accepting/accepted/rejected preserve pipeline success identity. A
knowledge generation's requester (`requestedById`) is the user who requested it:
a Maintainer+ for manual rebuilds, and the admin whose save changed the
embedding identity for `embedding_change` (attributed through
`knowledge.lastRoutingChange`). The build is a personal row for that user in
the `mine` audience only in projects where they are Maintainer+; its state
follows the build only (`running`/`succeeded`/`blocked`/
`failed`/`cancelled` from the generation's own status, never document counts)
and its revision is fixed at the build's terminal time
(`activatedAt`/`completedAt`/`supersededAt`), so a later document update to the
same active generation does not reopen it. Cleanup removes at most 5000
receipts older than 14 days inside failure-isolated `system.reconcile`
housekeeping on every worker role.

A notebook row (`notebookSource.ts`) is a current-digest, current-parser
`ArtifactNotebook`: personal for `requestedById`, Project work for Maintainers,
`ready`→`succeeded`, error text from `NOTEBOOK_ERROR_MESSAGES` only, revision fixed
by status/`queuedAt`/`finishedAt`, destination the Files page `?file=`.

A Git sync row (`gitSyncSource.ts`, kind `git_sync`) exists only while a
`ProjectGitRemote` is failing: enabled with `lastErrorCode`, or any
`lastPullErrorCode`. It is personal for every Owner and Maintainer (never
Editors/Viewers), always `failed`, with the member-safe text of
`documents/gitRemoteMessages.ts` (browser-safe, shared with the settings card) and the
project Settings page as destination. Its revision hashes the error codes with
`lastPushedAt`/`lastPullAt`, so retries stay acknowledged and a later incident
is unseen again. A new failure source needs the same pieces: a source SQL in
the union, the kind in `backgroundWorkSchema.ts`/`rows.ts`/dashboard rows, a
`PersonalWorkKind` enum migration, and label/destination/filter entries in the UI.

Each row also carries `errorMessage: string | null`, sourced only from that
row's own source column — `ScheduledTaskRun.errorMessage`,
`AssistantRun.errorMessage` (owner-only, never exposed to Maintainer/Admin
readers), `IngestionFile.failureMessage`, `KnowledgeGeneration.failureSummary`
— never a joined or derived table. Bound it to 500 characters counted by code
point (`[...value].length`, not `z.string().max(500)`, which counts UTF-16
units and can throw on a 500-character message containing astral characters
such as emoji). The row/tray/table render it with a two-line clamp and the
full text in `title`.

`BackgroundWorkProvider` owns one principal-keyed summary query per shell; bell/tray
and `/account/background-work` use typed source links. Poll 15s idle/5s active or
open, never hidden. Access errors immediately discard cached content; transient
errors label stale content. Auto-ack only successfully rendered recent personal
tray items; page acknowledgement is explicit. Keep assistant unseen state independent.
Use `backgroundWork.spec.ts` for source/access/paging/receipt coverage and the browser
spec for focus, navigation and cross-session unread behavior.

## Dashboard activity (Phase 6C)

`services/dashboard/activity.ts` reuses the authorized work relation for terminal
results from the last seven days and combines it with current document/table
updates from the last 30 days. This is a latest-update feed, not a complete edit
history. The Activity page uses the server-provided audience, defaulting to
personal work when none is given. Shared activity requires explicit `audience: projects`, an explicit
project and Maintainer/content:read; cursors bind this audience. Project overview
passes the snapshot's `workAudience`. Assistant results remain owned and readable
across their full saved scope in both audiences.

Successful task results suppress a matching content entry only when output
project/document/commit matches the current projection, before pagination.
Current report links open current content. Dashboard reads never insert or update
receipts, and dashboard rows have no unread dots. Only first activity pages poll
(30 seconds while visible); historical pages do not auto-refetch. Project active
previews use existing backgroundWork.list with limit3 and the authorized audience.

## External call housekeeping

Failure-isolated `system.reconcile` runs `reconcileExternalMcpState(db, now)`.
Approval expiry/terminal-parent cleanup and stale call settlement use 500-row
batches. Metadata pruning removes at most 5,000 expired settled rows (30-day
retainedUntil) per pass and excludes active assistant/task runs. Active task calls
use ScheduledTaskRun's lease, never an assistant attempt lease. Each lifecycle
transaction follows attempt→run→connection→call→approval, or task run→connection→call.
Interrupted dispatches become unknown; no external request is replayed. Assistant
recovery independently checks durable dispatch before either retry branch.

## Project Git push and pull jobs

`services/projectGitRemoteJobs.ts` discovers enabled live projects with encrypted
keys once per minute, and also dispatches a due push immediately after a remote
save/key upload/content commit via `notifyProjectContentChanged`/
`dispatchProjectGitRemote` — the minute pass is the fallback, not the only
trigger. Queue tickets and 180-second leases use conditional claims;
results match both configuration revision and lease token. Configuration/key
mutations preserve an admitted lease while invalidating queued work; removal is
blocked until the lease finishes. Admission serializes with the Project row before
checking soft deletion; network work runs outside database/repository locks.
Push failures use durable 1/5/15/60-minute backoff, independent of pg-boss retries;
stale queue tickets and leases become eligible for discovery again.

`@weaver/git-store/remote` captures HEAD under a shared read lock and skips network
when unchanged. It pushes the immutable SHA fast-forward-only through isolated
OpenSSH with first-use host pinning. The worker's 120-second abort matches the transport deadline and stays shorter
than its lease; do not remove that bound. Payloads contain projectId/queueToken,
never credentials or remote error output. Key/config management is session/Owner
only in `services/projectGitRemote.ts`. Test both `projectGitRemote.spec.ts` and
`projectGitRemoteJobs.spec.ts` for this area; transport unit tests use generated
keys and temporary bare repositories, never external credentials.

`project.git-pull` (payload `{ projectId, pullToken }`, `retryLimit: 0`,
Owner-requested and re-runnable, independent of the automatic-push toggle) is
admitted the same way, under `Project FOR UPDATE`, and shares its row's
`leaseToken`/`leaseExpiresAt` with push — at most one of either is in flight
per project. `fetchRemoteBranch` fetches the remote branch into a temporary
bare repository outside the lock; `services/projectGitRemoteMerge.ts`
(`mergeFetchedBranch`) does the actual merge inside `withExistingProjectRepo`,
with the lease renewed under the fence right after the fetch so the merge
starts with a full window; see `weaver-documents` for the merge tree
invariants. The pull's own outcome
(`lastPullSha`/`lastPullAt`/`lastPullErrorCode`) is written in its own fenced
update immediately after the merge, before the subsequent
`rebuildIndex`/`rebuildTableIndex` (run as the project's earliest Owner
member, falling back to the requester); `project.reconcile` is enqueued after
those rebuilds, and the lease is renewed across that work; a lease-renewal loss skips the
rebuilds and captures `git.remote.pull_rebuild_failed` rather than losing the
already-recorded outcome. A failed push attempt or fetch still completes its
job, so it captures `git.remote.push_failed`/`git.remote.pull_failed` (error,
`details.code` and operator-only `details.cause`) besides the stored error code. `lastPushedSha` is cleared only when the pull
actually changed HEAD. A follow-up push is dispatched only after the pull's
own lease-release `finally` has run, to avoid self-deadlocking against that
still-held lease. Errors record `GitRemoteError.code`, the 60-second fetch
deadline (the merge itself is unbounded) as `TIMEOUT`, or `MERGE_FAILED`
otherwise; test coverage is
`projectGitRemotePull.spec.ts`. `pullQueueToken` expires like a push
`queueToken` after `PROJECT_GIT_QUEUE_TTL_MS`, so a job that never admits
(push holds the lease, the key was deleted, the worker shut down) cannot
leave the row queued forever; saving a different remote URL/branch and
deleting the key clear it outright.

## OneNote artifact preparation

`artifact.notebook.prepare` runs on the ingestion role with an identifier-only
`{projectId, artifactId, contentDigest}` payload. `artifactNotebookJobs.ts` claims
a queued `ArtifactNotebook` using a new token and fences publication against
the artifact's live digest and token. Duplicate active deliveries are no-ops.
Worker cancellation returns the claim to queued; timeout/parser failure becomes
failed. `system.reconcile` recovers queued or expired running claims and sweeps
abandoned snapshots. Keep the job lease longer than the five-minute parser
deadline. Notebook preparation status appears in assistant/MCP tool responses; it is not
an ingestion pipeline run or a background-work completion receipt.

Deployment-wide schedule ownership uses `WEAVER_ENABLED_WORKER_ROLES` (default
all roles), identically configured on every worker. Local `WEAVER_WORKER_ROLES`
must be a subset; registration rejects an excluded local role before any
schedule changes. Startup unschedules assistant/task/Git cron jobs only when
their role is disabled deployment-wide, preserving schedules belonging to
other split workers. Update both role lists and restart all workers when
disabling a role; queued work remains durable. See `docs/setup.md`.

`project.reconcile` optionally carries `repairDocumentIds` for a post-commit
projection failure. Repair deliveries have a separate singleton key from ordinary
reconciliation; the worker repairs those Git-backed document projections under the
shared repository lock before indexing, so a committed create cannot remain missing
merely because its first projection transaction failed.

## Exams

`exam.tick` runs every minute under the tasks role and expires abandoned attempts with a ten-second save grace. Personal `exam` work requires a current trainee role and is excluded from shared audiences. See `weaver-exams`.

## Review hardening invariants

Materialized background-work sources must filter terminal history before the union while retaining active rows of any age. Scheduled-task free-text errors are owner-only. Exclude knowledge tombstones from live totals and failure counts.
