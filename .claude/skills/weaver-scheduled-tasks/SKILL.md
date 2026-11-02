---
name: weaver-scheduled-tasks
description: Use when working on Weaver scheduled AI tasks — the ScheduledTask/ScheduledTaskRun model, preset schedules and the minute tick, the task security context, the @weaver/ai task runner and context assembly, run history, or the Project › Tasks and Account › Tasks UI.
---

# Weaver Scheduled Tasks

Phase 6A.
A task is owned by one user, reads an assistant-style scope snapshot, and
writes into one output project/folder on a preset schedule. A run is one
unattended `generateText` completion over prepared context — no tools, no
proposals — that replaces the task's single living output document, committed
as the owner with task/run provenance in the trailers so the document's Git
history holds every past report.

## Key files

| Path                                                                                                              | Role                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db/prisma/schema.prisma` (`ScheduledTask`, `ScheduledTaskRun`)                                          | The two tables: definition/schedule/status on the task, one row per run with status, trigger, lease, output, tokens, error                                                                                     |
| `packages/db/prisma/migrations/20260918000000_scheduled_tasks/`                                                   | The migration adding both tables and their enums                                                                                                                                                               |
| `packages/config/src/workerRoles.ts`                                                                              | `tasks` in `WORKER_ROLES`/`DEFAULT_WORKER_ROLES`                                                                                                                                                               |
| `packages/config/src/jobs.ts`                                                                                     | `WEAVER_TASK_TICK_CRON`, default `* * * * *`                                                                                                                                                                   |
| `packages/core/src/jobs/types.ts`                                                                                 | `task.tick`/`task.run` payloads, the `TaskRunner` type, `task.run`'s 20-minute expiry and task-id singleton key                                                                                                |
| `packages/core/src/jobs/runtime.ts`                                                                               | Registers both consumers and schedules `task.tick` only under the `tasks` role; a missing injected `taskRunner` acks and warns per job, like `assistant.run`                                                   |
| `packages/core/src/security/context.ts`                                                                           | `"task"` `AuthenticationMethod`, `createTaskSecurityContext`                                                                                                                                                   |
| `packages/core/src/scheduledTasks/scheduleSchema.ts`                                                              | Hourly/daily/weekly/monthly preset schema, `scheduleToCron`, `describeSchedule`, `TASK_FAILURE_CODES`, `TASK_SKIP_REASONS`, limits (browser-safe: zod only)                                                    |
| `packages/core/src/scheduledTasks/schedule.ts`                                                                    | `nextOccurrence` via `cron-parser`, always passing an explicit `tz`                                                                                                                                            |
| `packages/core/src/scheduledTasks/context.ts`                                                                     | `assembleTaskContext`/`computeTaskBudget`: change-digest and scope-content assembly within the routed model's context window, one equal budget share per scoped project                                        |
| `packages/core/src/scheduledTasks/tick.ts`                                                                        | `runTaskTick`: claim due tasks, re-dispatch stale-queued runs, expire abandoned leases                                                                                                                         |
| `packages/core/src/services/projectActivity.ts`                                                                   | `projectChangesSince`: commits since a recorded head (or a 7-day fallback window) mapped to changed documents/tables; reused by 6C                                                                             |
| `packages/core/src/services/scheduledTasks.ts`                                                                    | Policy owner: CRUD, pause/resume/run-now, limits, `leaseTaskRun`/`heartbeatTaskRun`/`skipTaskRun`/`succeedTaskRun`/`failTaskRun`, `claimDueTasks`                                                              |
| `packages/git-store/src/gitStore.ts` (`logSince`)                                                                 | Commit log since a SHA or a date window, consumed by `projectChangesSince`                                                                                                                                     |
| `packages/ai/src/taskPrompt.ts`                                                                                   | `TASK_SYSTEM_PROMPT`, `buildTaskPrompt`                                                                                                                                                                        |
| `packages/ai/src/taskRunner.ts`                                                                                   | `createScheduledTaskRunner` (`@weaver/ai/taskRunner`): lease, live owner-flag skip, actor, route, budget, digest, generation, output, accounting                                                               |
| `apps/agent-worker/src/index.ts`                                                                                  | Injects `taskRunner: createScheduledTaskRunner({ db, ring, workerId })` into `startKnowledgeWorkers`, beside `assistantRunner`                                                                                 |
| `apps/web/src/server/api/schemas/scheduledTask.ts`, `apps/web/src/server/api/routers/scheduledTask.ts`            | Input schemas and the `scheduledTask` tRPC router (`authedProcedure` only; service calls enforce membership)                                                                                                   |
| `apps/web/src/app/(workspace)/projects/[projectId]/tasks/page.tsx`                                                | Project › Tasks list route                                                                                                                                                                                     |
| `apps/web/src/app/(workspace)/projects/[projectId]/tasks/[taskId]/page.tsx`                                       | Task detail route                                                                                                                                                                                              |
| `apps/web/src/app/(workspace)/projects/[projectId]/tasks/_components/{TasksScreen,TaskDialog,scheduleForm}.ts(x)` | List screen, create/edit dialog, and schedule-preset form helpers — all under the flat `tasks/_components/` directory                                                                                          |
| `apps/web/src/app/(workspace)/projects/[projectId]/tasks/_components/{TaskDetailScreen,RunHistoryTable}.tsx`      | Task detail screen (definition, output link) and the cursor-paginated run-history table — also in `tasks/_components/`, not under `[taskId]/`                                                                  |
| `apps/web/src/app/(workspace)/account/tasks/page.tsx`, `_components/MyTasksCard.tsx`                              | Account › Tasks: every task the signed-in user owns, across projects                                                                                                                                           |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/MaintainedByTaskBanner.tsx`              | Output-document banner, driven by `scheduledTask.byOutputDocument`                                                                                                                                             |
| `apps/web/src/app/(workspace)/_components/{UserMenu,ProjectSections,WorkspaceBreadcrumbs}.tsx`                    | Account-menu "Tasks" entry, project-nav "Tasks" section, and the three breadcrumb trails                                                                                                                       |
| `apps/web/tests/integration/scheduledTasks.spec.ts`                                                               | Router/service coverage: CRUD/role matrix, limits, run-now/`CONFLICT`/undispatchable, edit and `byOutputDocument`, per-project context shares, concurrent ticks, the runner end to end, skip/pause/`ABANDONED` |
| `apps/web/tests/e2e/tasks.spec.ts`                                                                                | Tier 3 browser flow: create a task from the UI, run it now, watch it succeed, and open the output document and its banner                                                                                      |

## Conventions

- A task writes only its own output document directly; it never touches
  anything else — the interactive assistant's propose-only rule protects
  reviewed edits, but a scheduled report is unattended by definition and the
  commit carries the same owner-attributed provenance as an accepted
  proposal or an MCP write.
- One model: owner + scope + output project. A project's list is "tasks
  that write here" (`listForProject`); the personal list is "tasks I own"
  (`listMine`). Runs execute with the owner's live permissions, not the
  creator's permissions at creation time.
- One living output document per task — replacing it each run keeps the
  project free of dated copies while Git history holds every past report;
  run history links to the exact output commit. A run's destination is
  immutable history: `succeedTaskRun` stores `ScheduledTaskRun.outputProjectId`
  (taken from the written document, not from the task, whose output project
  can change later), `listTaskRuns` returns it only to a reader who can still
  open that project (otherwise `null`, and the UI shows the SHA without a
  link), and `RunHistoryTable` links to
  `documentVersionHref` — `/projects/<run project>/documents/<id>?version=<sha>`
  — which opens the document compared against that saved version. Never build
  a run link from the route's or the task's current project. The task detail's
  "current report" link stays separate.
- Blocks are admitted with `fitWithinBudget`: whole blocks in order, then the
  head of the first block that does not fit (`cutToBytes`: title line kept,
  `_[truncated]_` marker) when at least `MIN_PARTIAL_BLOCK_BYTES` (256) remain,
  then nothing further. Separators count as the two bytes of the `\n\n` join,
  and shares reserve the separators between projects. `summary.truncated` is
  true whenever anything was dropped, partially fitted, or cut at its source
  (32 KB document cap, 50-row table sample, diff cap). A selected document is
  never dropped whole for being larger than the budget.
- Quota admission: `assertLimits` runs only inside a transaction and first
  takes two transaction-scoped advisory locks in a fixed order —
  `weaver:task-quota:owner:<ownerId>`, then
  `weaver:task-quota:project:<projectId>` — before recounting. `createTask`
  validates outside and opens a short lock → count → create transaction;
  `updateTask` calls it after the task-row lock with the moved task excluded
  from the owner count. Never count on the root client, and never take the
  locks project-first.
- Scope content is budgeted per project: a project/projects/all scope splits
  the content budget into equal shares (`contentBudget / projectIds.length`),
  fills each project's documents and then its tables inside its own share, and
  leaves an unspent share unused — filling project by project would starve
  every project after the first. `TaskContextSummary` therefore carries both
  the aggregate `documents`/`tables`/`commits`/`truncated`/`fallback` and a
  `projects` array (`projectId`, `documents`, `tables`, `commits`) recording
  what each scoped project actually contributed; it is stored on the run as
  `contextSummary`.
- `runNow` deletes the run it just created and fails with
  `PRECONDITION_FAILED` when `dispatchTaskRun` cannot enqueue the job (jobs
  disabled, or the runtime already stopped). An undispatched `queued` row
  would never reach a worker and would block every later run with `CONFLICT`.
  The tick's stale re-dispatch is the recovery path for a run that _was_
  dispatched.
- Schedules are presets (hourly/daily/weekly/monthly) plus an IANA timezone,
  stored as a cron string. No free cron input. Minimum interval one hour;
  missed slots are skipped, never caught up; a task never overlaps itself.
- A run is one `generateText` completion over prepared context, without
  tools — the `jobs` route only requires `chat` capability, so a cheap local
  model works, and the failure model stays simple and fully testable against
  a mock model.
- Require `finishReason: stop` and nonempty content before writing a report.
  Incomplete output fails with `CONTENT_INVALID`, retaining the previous output
  document and successful change baseline. Actual tokens remain accounted as
  `validation_failure`; accounting outages emit `ai.usage.failed` independently.
- Scheduling is a minute tick over the `ScheduledTask` table
  (`runTaskTick`), not a pg-boss keyed cron per task: pause, edit, next-run
  display, and last-run semantics need a Prisma-owned table regardless, and
  `claimDueTasks`'s conditional `nextRunAt` update means two workers ticking
  at once claim a due task exactly once.
- A run acts through `createTaskSecurityContext`
  (`authenticationMethod: "task"`, `credentialId: "task-run:<runId>"`,
  capabilities `content:read`/`content:write` only, `allowedProjectIds:
"all-accessible"`) — never assistant, propose, or admin capabilities, even
  for an Admin owner; core-service membership checks apply exactly as for a
  session actor. The services that refuse tasks also refuse every non-human
  principal (`isHumanPrincipal`), so the wiki agent cannot pass them.
- The owner's `banned` (active ban) and `mustChangePassword` flags are read
  **live**, at lease time, inside `leaseTaskRun`/the runner — never cached on
  the task and never checked on the bearer/API path. A live flag skips the
  run (`errorCode: "owner_inactive"` / `"owner_password_change"`); the task
  stays `active` and resumes by itself once the owner is reactivated or
  changes their password.
- `errorCode` on a run is either a `TASK_FAILURE_CODES` value
  (`ROUTE_MISSING`, `SCOPE_EMPTY`, `OUTPUT_FORBIDDEN`, `OUTPUT_MISSING`,
  `OUTPUT_CONFLICT`, `PROVIDER_ERROR`, `TIMEOUT`, `CONTENT_INVALID`,
  `ABANDONED`) or a `TASK_SKIP_REASONS` value (`overlap`, `owner_inactive`,
  `owner_password_change`) for a `skipped` run. Every failure code except ABANDONED counts
  toward the five-consecutive-failure auto-pause; skipped runs neither count
  nor reset the counter. `SCOPE_EMPTY` covers both an empty effective scope
  and a document or table the scope names that is gone or unreadable at
  assembly time. `OUTPUT_CONFLICT` is the write layer's `CONFLICT` (the output
  document's base revision moved under the run), surfaced by `saveDocument`'s
  normal optimistic-concurrency check — a task never forces its write.
- Every failure code is decided where the failure happens: `writeOutput` maps
  the output write's `CoreError`s, `runTask` maps `assembleTaskContext`'s to
  `SCOPE_EMPTY`, and `toFailure` is the last resort that reports anything else
  as `PROVIDER_ERROR` with a redacted message. Never classify a bare
  `CoreError` code as an `OUTPUT_*` failure in `toFailure` — it wraps the whole
  run, so a scope read would borrow an output meaning.
- Diagnostic events use category `task`: `task.created`, `task.updated`,
  `task.deleted`, `task.paused`, `task.resumed`, `task.run.started`,
  `task.run.succeeded`, `task.run.failed`, `task.run.skipped`. Run events
  carry ids, error code, duration, and token counts — never the instruction
  body or generated content. `AiUsage.operation = "task.run"` attributes cost
  to the `jobs` purpose (labeled "Scheduled tasks" in Administration › AI;
  see `weaver-admin`) per model and project.
- `nextOccurrence` always passes `cron-parser` an explicit `tz`; never parse
  a cron string without one, or a DST transition resolves in the server's
  local time instead of the task's declared timezone.

## MCP diagnostic reads

`packages/core/src/services/scheduledTaskInspection.ts` and
`packages/assistant-tools/src/tools/admin/scheduledTaskRead.ts` expose
`list_scheduled_tasks`, `get_scheduled_task`, `list_scheduled_task_runs`, and
`get_scheduled_task_run` in `ADMIN_TOOLS` only. All four require `system:admin`,
MCP scope and output-project Maintainer membership with `content:read`.
Definitions include every stored task field; run details include every stored
run field, including lease/job/worker, project heads, context and error message.
Details additionally require read membership and MCP scope for requested/resolved
source projects and historical run projects in heads/context. Summary lists omit
instructions, scope content, context and free-text errors.

Task lists accept owner/status and oldest/newest creation order; run lists accept
status and inclusive queued-time bounds. Lists use canonical timestamp/id cursors
and `pagedOutput`. Small details return `record`; oversized details return
`record: null` with lossless JSON text pages (`json`, `offset`, `nextOffset`,
`totalChars`, `revision`, `truncated`). Concatenate pages before parsing;
`maxChars` forces paging. Continuations require the first page's `revision` as
`expectedRevision`; changed records return `CONFLICT` and the caller restarts
from offset 0. Diagnostic/usage/queue tools use the returned run/job IDs.
Coverage lives in `adminInsight.spec.ts` and `mcpServer.spec.ts`.

## Testing

- Integration coverage is `apps/web/tests/integration/scheduledTasks.spec.ts`
  — the full role/limit/lifecycle matrix, concurrent-tick claiming, and the
  runner exercised end to end. Follow the assistant-runner/ingestion pattern:
  build an `ai/test` `MockLanguageModelV4` and pass it as `modelFactory` to
  `createScheduledTaskRunner`/`executeScheduledTaskRun`; never call a real
  provider. Assert the output document, its `Weaver-Operation-Id`/
  `Weaver-Run-Id` commit trailers, the `AiUsage` row, and that a second run
  updates the same document while excluding it from its own digest.
- The Tier 3 browser flow drives the UI against the deterministic mock AI
  server's task branch, seeded through the e2e `jobs` route (see
  `weaver-testing`).
- Follow `weaver-trpc-routers` for the router adapter, `weaver-database` for
  schema/migration conventions, `weaver-jobs` for the worker/queue runtime
  the tick and runner plug into, and `weaver-forms-dialogs`/
  `weaver-entity-tables` for the create/edit dialog and list conventions.

## Background-work read model

Phase 6B reads ScheduledTaskRun through services/backgroundWork/taskSource.ts. My work requires owner + output-project access; Project work requires output-project Maintainer. The bell/tray/history link back to the existing task page and do not alter run execution or task management. Exact terminal run revisions drive personal completion receipts; see weaver-jobs.

## Required external inputs (Phase 7A)

`TaskDefinitionInput.externalInputs` is optional on create/update: omitted create
means `[]`, omitted update preserves saved inputs, explicit `[]` removes them.
Detail returns `{name, toolId, arguments}[]`; `arguments` maps top-level keys to
`literal` (recursive JSON), `period_start`, or `period_end` bindings. Names are
case-insensitively unique; at most five inputs. Unchanged name/tool/bindings retain
IDs across reorder; changed inputs receive new IDs. External-input definition
edits and deletion reject queued/running tasks with actionable `CONFLICT`; task-row
locks serialize definitions, manual/tick admission and leases. All definition edits reject queued/running tasks to keep the output destination
stable while publication is admitted. No-input prompt and context budgets are unchanged.

`scheduledTasks/externalInputs.ts` owns saved binding validation and sequential
Task 5 execution. Required inputs use the owner's own enabled read tools, with live owner flags and source/output memberships. Never
shrink a saved scope after access loss. The captured UTC period starts at the last
successful external period end (legacy fallback: completion; first run: seven days).
External-period digests use the captured date range rather than later repository
heads, so commits made during input retrieval remain visible in the next period.
Half the available input bytes is reserved for external context and divided equally;
UTF-8 framing/metadata consume each share, truncation is visible, insufficient
required framing fails `EXTERNAL_CONTEXT_LIMIT`.

Each attempted input persists `contextSummary.externalInputs` with `inputId`,
`name`, `connectionId`, `toolName`, `status` (`completed`/`failed`), `retrievedAt`,
`durationMs`, `truncated`, `errorCode`, and optional remote `outcome`; failed runs retain completed and failing
summaries, never raw arguments/results. `contextSummary.period` stores ISO start/end.
Failures use the closed `EXTERNAL_*` codes in `scheduleSchema.ts`. No later input,
model call or publication follows a failed required input. The runner enters body
suppression before external work/model construction, makes one tool-free completion,
reserves footer space, escapes Markdown source names, and rechecks live input/output
authority before write. Task diagnostics exclude external input summary details.
Admin inspection exposes saved inputs only after its existing all-source checks.

Historical calls store immutable `inputSnapshotId`; live `inputId` becomes null on
removal, so completed tasks remain editable. Unique run/snapshot IDs prevent duplicate
calls. Never remove active-run dispatch evidence. Coverage:
`scheduledTaskExternalInputs.spec.ts` plus the legacy `scheduledTasks.spec.ts`.

## External-input task UI

`tasks/_components/ExternalInputsEditor.tsx` is shared by the project and account
`TaskDialog` entry points. Its props remain `{scope, outputProjectId, value,
onChange, disabled}` with `ExternalInput[]`; each scope/output query uses the
normal availability API and choices intersect the owner's current read tools on
connections that do not ask before every call. Hide
stale/error choices while retaining saved input definitions for repair/removal.
MCP unconfigured/errors must not block a native empty-input task.

`lib/tasks/externalInputs.ts` parses literal JSON objects without evaluating strings.
The editor sets native field validity and inline feedback for invalid JSON; the
outer form calls `reportValidity` before RHF submission, then validates the full
input list with the browser-safe schema. Scope and external inputs are local form
state because recursive JSON is unsuitable for RHF field-path inference. Unrelated
edits and background refresh preserve drafts; closing unmounts the form so reopening
loads the latest definition. Explicit `[]` removes inputs; never silently filter an
unavailable saved tool out of the payload. Explain active-run `CONFLICT` as waiting
for queued/running work to finish.

Detail viewers get only the stored input list, without editable argument controls.
`RunHistoryTable` parses unknown/legacy `contextSummary.externalInputs` through a
bounded metadata schema, shows status/retrieval/truncation and controlled failure
copy, and never renders raw result/credential fields. Account editing loads live
task detail and gates the same dialog on `canManage`; run-now keeps server admission
as authority for a changed connection. Mounted renderer tests exercise real form
callbacks and RHF transitions; browser focus/layout verification belongs to Tier 3.

Browser acceptance for required external inputs lives in `external-mcp.spec.ts`:
create a read input on a connection that does not ask before every call, run now, verify source connection/tool/retrieval/call
provenance in the report, switch policy to ask, and verify a failed input leaves
both the previous report content and Git history unchanged. No external input or
model call may continue after a required input fails; retries never replay an
already-dispatched external call.

Safe external causes share `externalMcp/errors.ts` with assistant activity. Preserve
unsupported protocol/schema, forbidden access, tool drift, invalid result and overflow
codes in required-input failures. `outcome: unknown` remains independent of cause;
history shows the deterministic may-have-completed/no-automatic-replay warning.
Use own-property lookup for unknown error codes, including prototype-name keys.

## Tabbed task dialog and output target (0.1.166)

`TaskDialog` is a wide dialog with five plain tabs (General, Instructions, Focus,
Tools, Output). The tabs are hand-rolled `role="tab"`/`tabpanel` elements, not
the Radix `Tabs` primitive: every panel stays mounted (hidden) so RHF fields keep
their values and the mounted renderer tests need no DOM. A failed save opens the
tab that owns the rejected field (`FIELD_TAB`).

Output target: `TaskDefinitionInput.outputDocumentId` (uuid = write into that
existing document of the output project; `null` = start a new document on the
next run; omitted = keep the current target), `outputTitle` (title of a created
document, the task name when empty) and `outputMode` (`replace`, or `update`,
which puts the target's current Markdown into the prompt as "Current document",
capped at a quarter of the input budget and charged against the scope content).
A document can be the target of one task only (`CONFLICT` on
`outputDocumentId`). A deleted target is recreated in `outputFolderPath` under
`outputTitle`. Summaries carry `ownerEmail`; lists show it as "Runs as".

## Review hardening

Only owners may edit task definitions (`canEditDefinition`); output-project Maintainers
retain management actions. Every non-owner receives empty instructions, scope and external inputs,
and run history omits context summaries and free-text errors. Personal task lists retain
inaccessible owned tasks and offer deletion; owners can delete after output-project access
loss. Owner quotas count only accessible, nondeleted output projects. Soft deletion pauses
output tasks atomically and ticks exclude deleted outputs.

The runner acquires the project Git lock before `withTaskOutputLease` takes task → run
locks, so waiting for a busy repository cannot outlive the publication transaction.
`withTaskOutputLease` rechecks live status
and lease immediately before writing, and persists the output document identity before
releasing the lock. If acknowledgement fails after a returned write, it preserves the
output identity only while the original destination and previous pointer still match.
Expiry claims recheck the discovered cutoff so a heartbeat wins;
ABANDONED remains visible in history without advancing the automatic-pause counter.

Paused tasks reject Run now with actionable PRECONDITION_FAILED; the browser
requires resume first. `leaseTaskRun` skips paused queued runs as `task_paused`
without provider calls or failure-count increments. Output-project Maintainers
retain explicit management/run authority but never receive owner-private input
or run-detail fields. Publication lease authorization failures are classified as
OUTPUT_FORBIDDEN, including permission loss while waiting for the Git lock.
External input JSON escapes angle brackets before framing and byte budgeting so
remote names, metadata and values cannot close their untrusted delimiter.

## Review hardening invariants

Schedule ticks advance nextRunAt without adding a run when queued/running work exists under the task-row lock. Publication persists output identity and completion metadata as a receipt before later acknowledgement. Success is idempotent; retry acknowledgement without regenerating. Expiry reconciliation acknowledges published receipts instead of increasing provider failure counts.

Persist completion metadata before publication. Missing receipt identity is recoverable only from a unique locally trusted Git commit with the exact task-run operation and run IDs. Expiry of prepared output locks the repository before rereading the run and taking task locks, matching the writer lock order. Unprepared expiry atomically requires a null output project; failure transitions require no accepted output SHA.
