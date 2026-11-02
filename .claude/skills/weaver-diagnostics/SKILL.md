---
name: weaver-diagnostics
description: Use when working on Weaver diagnostic events, diagnostic settings or retention, correlation and provider capture, diagnostics lifecycle hooks, the Administration Diagnostics page, or diagnostic admin MCP tools.
---

# Weaver Diagnostics

## Quick reference

| Path                                                                           | Role                                                                                                |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `packages/core/src/diagnostics/settings.ts`                                    | Settings schema and defaults (`standard`, 7 days, 24 hours, 1,000,000 rows)                         |
| `packages/core/src/diagnostics/context.ts`                                     | AsyncLocalStorage correlation and callback binding                                                  |
| `packages/core/src/diagnostics/processState.ts`                                | `globalThis` holders for writer, settings cache, and context state                                  |
| `packages/core/src/diagnostics/writer.ts`                                      | Non-blocking queue, bounded readiness/drain, counters                                               |
| `packages/core/src/diagnostics/sanitize.ts`                                    | Privacy boundary and Unicode-safe field/body caps                                                   |
| `packages/core/src/diagnostics/fetch.ts`                                       | Failure-isolated provider capture and `ai.request`                                                  |
| `packages/core/src/diagnostics/events.ts`                                      | Typed event/category catalog                                                                        |
| `packages/core/src/diagnostics/errorSummary.ts`                                | Bounded, redacted `ErrorSummary` for `details.error`                                                |
| `packages/core/src/diagnostics/networkFailure.ts`                              | Transport and outbound-policy causes in user-facing words                                           |
| `packages/core/src/diagnostics/reference.ts`                                   | Eight-hex reference ids, ` (ref …)` suffixes, id-range lookup                                       |
| `packages/core/src/services/diagnosticsSettings.ts`                            | Typed 15-second process cache, mutation, stats                                                      |
| `packages/core/src/services/diagnosticEvents.ts`                               | Filtered reads, body pages, advisory-locked pruning                                                 |
| `packages/core/src/diagnostics/retentionSettings.ts`                           | `retention` setting schema/defaults/parse (ingestion/assistant-conversation/task-run/AI-usage days) |
| `packages/core/src/services/retentionSettings.ts`                              | Admin-only get/set, advisory lock, `settings.changed`                                               |
| `apps/web/src/app/(workspace)/admin/diagnostics/_components/RetentionCard.tsx` | Retention settings form (React Hook Form + Zod)                                                     |
| `packages/assistant-tools/src/tools/admin/diagnostics.ts`                      | Eight MCP-only diagnostics contracts and output budgets                                             |
| `apps/web/src/server/api/routers/diagnostics.ts`                               | Admin tRPC surface                                                                                  |
| `apps/web/src/app/(workspace)/admin/diagnostics/`                              | React Hook Form settings/status UI plus the `EventsPanel` browser                                   |

## Insight services

See `weaver-admin` for the operational insight services and shared paging contracts.

## Invariants

- `DiagnosticEvent.createdAt` is supplied explicitly by the process as UTC. It has no database default after the appended `20260910090100_diagnostics_event_created_at_utc` migration. `DiagnosticEvent` has no foreign keys by design.
- `standard` is the default level and records processing lifecycle metadata. `errors` persists only `error` and `warn`; verbose events never persist below `verbose`. `emitDiagnostic` returns the event id (or null). Use `captureError` for a failure you can report immediately, and `reserveDiagnosticEvent` plus `id` when the event must wait for a transaction to commit but the stored failure summary needs the reference now. Append references with `withReference(message, reference, columnCap)` so the suffix survives the column cap; measure the cap on the text as stored, after any whitespace normalisation. User-facing network text never names a host. `ai.request` transport failures keep the closed classification under `details.classification` and put the summary under `details.error`; HTTP error responses keep `details.error: "http_error"`. Error summaries pass the details sanitizer unredacted (`isErrorSummary` in `sanitize.ts`) because `summarizeError` already caps and redacts them — never widen that exemption.
- Some failures must stay closed. A suppressed external provider, the generic `job.failed` runtime event, and an assistant or task run carrying external context omit `details.error` entirely; their errors may contain private content. `lifecycle.logFatal` receives an `ErrorSummary`, never the raw value. Lifecycle fatals are `startup-failure | uncaught-exception | unhandled-rejection | shutdown-timeout | shutdown-failure`; `shutdown-failure` (a rejected stop, health close or database disconnect, which makes the process exit 1) fires after the diagnostic writer has drained, so it reaches stderr and the exit code but not the diagnostics table.
- New event names: `runtime.error`, `trpc.error`, `assistant.stream.failed`, `content.projection.failed` (new `content` category), `knowledge.enqueue.failed`, `auth.plugin.failed`, `project_api.request.rejected` (`auth`; pre-authentication rejection with status, operation and error code only, never a key UUID or token), `project_api.audit.failed` (`content`), `document.summary.completed`, `document.summary.skipped`, `document.summary.retrying`, `document.summary.failed`, `document.summary.usage_failed` (`content`; closed reasons only, never `details.error`), `artifact.reader.failed` (`content`; an artifact reader child that crashed or never
  started — `cause`, `operation`, `artifactId`, `projectId` and the child's exit
  status, never the filename or file content),
  `knowledge.document.embedded` (paced request statistics) and `knowledge.search.degraded` (warn; reason/timeout/duration only). `knowledge.document.failed` carries `details.validation` when an `AiProviderError` has `details` (stage `json`/`schema`/`envelope`/`temporal`, counts, `issues` as `path: code message` strings capped at 20, `finishReason`); these are safe metadata built by `parseExtractionJson`/`describeExtractionIssues`, never provider text. After the one correction turn the same details also carry `correction` (`rejected`/`failed`) with `initialStage`/`initialIssues`; an accepted correction emits `knowledge.extraction.corrected` (warn; `chunkId`, `stage`, `issues`).
- `emitDiagnostic` is synchronous, never throws into application work, and is inactive before writer start or at `off`. Startup waits at most one second for the first settings read. Worker and MCP shutdown always attempt writer cleanup even when their primary drain fails; Next instrumentation drains under NEXT_MANUAL_SIG_HANDLE in the production image. Writer, settings-cache, and context state live on `globalThis` symbols via `processSingleton`; Next.js loads instrumentation and route handlers as separate module copies, so never add module-level diagnostics state.
- Category `wiki` has `wiki.settings.changed` (details: `change`, `revision`) and `wiki.guide.approved` (details: `digest`, `bytes`, `revision`; never the guide text). Later slices add the run and input events.
- Add every name to `DIAGNOSTIC_CATEGORY_OF`. Emit state-transition events only after the conditional write/transaction commits, and report accepted—not attempted—counts. `JobExecution.retryCount` is nullable. `assistant.attempt.cancelled` means committed user cancellation; `assistant.attempt.abandoned` means shutdown or ownership loss. Reconciliation requeues an abandoned attempt only while the run is active and its attempt budget remains; otherwise the run ends failed, or cancelled when cancellation was already pending.
- Treat the writer as the final privacy boundary. Never persist credentials or Authorization headers at any level. Conversation, document, message, and prompt content may appear only in sanitized verbose provider request/response body fields. Those bodies (including parsed SSE data frames) are JSON-sanitized and capped at 32,768 UTF-16 units without splitting a surrogate pair; sensitive properties, known request credentials, and recognizable key formats are redacted; malformed bodies become `[redacted body]`; numeric token counters remain visible. Pattern matching is a fallback, not a guarantee that arbitrary unknown secrets are recognizable.
- Set correlation once with `withDiagnosticContext`; use `bindDiagnosticContext` when another async caller invokes a callback later. MCP diagnostics follow the callback that wins the shared audit claim, yielding exactly one audit/diagnostic outcome. Only schema-validated project ids and admin argument names—not values—may be attached.
- Diagnostic list cursors come from the last item retained in the same bounded snapshot. Body pages are canonical in `diagnosticEvents.ts`: 12,000 UTF-16 units, surrogate-safe start/end, and `nextOffset` derived from the returned page. The MCP contract budgets the complete 16,000-character envelope and may shorten that page again.
- Pruning runs independently alongside `system.reconcile` recovery, regardless of level: verbose age, total age, then overflow. Each batch takes the shared PostgreSQL advisory transaction lock; the run is capped at 50 batches of 10,000.
- Every independent housekeeping failure emits `runtime.housekeeping.failed` with
  its operation and closed error class; other cleanup/recovery operations finish
  before the system job reports failure. MCP record cleanup runs here regardless
  of enabled worker roles.
- `ai.usage.failed` reports a usage-storage failure independently of provider
  success. `services/aiUsageBestEffort.ts` is the shared non-transactional helper;
  never catch a failed query inside a database transaction and continue that
  aborted transaction.
- `system:admin` implies `llm:admin`, is effective on a personal key only while its owner remains a global Admin, and is never an OAuth scope. Admin contracts live in `ADMIN_TOOLS`, never `ASSISTANT_TOOLS`; admin services begin with `assertSystemAdmin` (LLM services use `assertLlmAdmin`).
- The Diagnostics page uses React Hook Form plus Zod, preserves dirty fields across refetch, and synchronously serializes save/prune from validation or confirmation through mutation settlement.
- The Events list defaults to Info and above using `excludeDebug: true` before pagination. Exact severity takes precedence; Debug and All severities are explicit choices. Unfiltered service/MCP reads retain all severities. Routine `project.git-sync`, `task.tick`, and `assistant.reconcile` start/completion rows use debug; failures stay error. Debug remains captured at Standard/Verbose and follows normal event retention. Migration `20260921001300_routine_job_diagnostic_severity` reclassifies historical info rows for those checks without deleting them.
- The Events panel reads project, generation, run, document, file, and job IDs as
  clearable correlation filters and has the `events` anchor. Processing links use
  run IDs for tasks/assistant, document+generation for knowledge, file IDs across
  ingestion stages, and job IDs for individual queue deliveries. `fileId` is a
  validated `details.fileId` filter backed by migration `20260922000600_diagnostic_file_correlation`;
  its single bounded SQL query keeps the same filter/paging behavior as other reads.
- `services/processingInspection.ts` exposes metadata-only durable states and
  queue status independently of logging level. Never return source content,
  filenames, or raw failure messages. The first page polls; cursor pages are stable.
- `services/processingRetention.ts` removes terminal assistant events after 7 days
  and terminal assistant attempts after 30 days (fixed constants), plus AI usage,
  terminal task runs, finished ingestion batches, and idle assistant conversations
  at the periods in the `retention` `SystemSetting` (`getRetentionSettings`, read
  once per pass). At most 5,000 rows per table/pass; idle conversations are
  additionally capped at min(batch size, 1,000).
  Idle-conversation pruning is skipped entirely when `assistantConversationDays`
  is 0, and never removes a conversation with an active/recent run, a
  pending/accepting proposal, or external MCP call/approval evidence. Preserve
  active work, task baselines/latest runs, user content, and externally retained
  evidence. Drain event children before attempts.
  Queue history expires after 7 days; bounded MCP records keep their 30/90-day policy.
- The `retention` `SystemSetting` (`RETENTION_SETTING_KEY`, `retentionSettings.ts`)
  holds `ingestionDays` (1–365, default 30), `assistantConversationDays` (0–730,
  default 90, 0 = keep), `taskRunDays` (1–365, default 30), and `aiUsageDays`
  (1–730, default 90). A stored value that fails validation is treated as
  defaults, never as an error. `setRetentionSettings` requires `system:admin`,
  takes the `weaver:retention-settings` advisory lock, and emits
  `settings.changed` with before/after values. The Retention card
  (`RetentionCard.tsx`) and the MCP tools `get_retention_settings`/
  `set_retention_settings` are the only writers; the Processing card's
  retention sentence only reads the live values.

## Complete admin tool registry

All contracts require `system:admin` and are excluded from `ASSISTANT_TOOLS`.
Write tools carry destructive annotations and await their actual result.

| Kind                      | Tools                                                                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read: diagnostics         | `get_diagnostics_settings`, `get_retention_settings`, `list_diagnostic_events` (accepts `reference`), `get_diagnostic_event` (exactly one of `id` or `reference`), `list_document_change_summaries` (metadata only)  |
| Write: diagnostics        | `set_diagnostics_settings`, `set_retention_settings`, `prune_diagnostic_events`                                                                                                                                      |
| Read: operations          | `admin_overview`, `admin_health`, `list_queue_jobs`, `get_queue_job`, `queue_summary`, `list_ai_usage`, `ai_usage_summary`                                                                                           |
| Read: LLM                 | `list_llm_connections`, `list_llm_models`, `list_llm_routes`                                                                                                                                                         |
| Read: knowledge           | `get_knowledge_status`, `list_knowledge_generations`, `list_generation_documents`                                                                                                                                    |
| Read: assistant and audit | `list_assistant_runs`, `get_assistant_run`, `list_mcp_audit_events`                                                                                                                                                  |
| Read: scheduled tasks     | `list_scheduled_tasks`, `get_scheduled_task`, `list_scheduled_task_runs`, `get_scheduled_task_run`                                                                                                                   |
| Write: LLM                | `create_llm_connection`, `update_llm_connection`, `delete_llm_connection`, `test_llm_connection`, `create_llm_model`, `update_llm_model`, `delete_llm_model`, `import_llm_models`, `test_llm_model`, `set_llm_route` |
| Write: knowledge          | `rebuild_knowledge_index`, `retry_failed_knowledge`, `enqueue_reconcile`                                                                                                                                             |

LLM writes use shared core schemas and administration services with injected
`ToolContext.llm` dependencies. Provider test HTTP must use fakes. Knowledge
mutations preserve `content:write` and Maintainer membership after scope checks;
global reconciliation is an instance-level admin operation.

## Verification

Use colocated diagnostics unit tests, `apps/web/tests/integration/diagnostics.spec.ts` for settings/hooks/queries/pruning, and `mcpServer.spec.ts` for registration, audit ownership, pagination, and demotion. Follow `weaver-testing` for the permitted tier and database pair.

## Common mistakes

- Emitting before a transaction commits produces events for work that rolled back.
- Slicing a body or cursor again outside the core/MCP boundary duplicates or skips Unicode text.
- Logging raw errors, tool arguments, or source details can expose private content even when credential keys are redacted.

- A verbose body requires membership in its project and every immutable `DiagnosticEvent.bodyProjectIds` entry. Assistant capture stores the union of current scope and all leased messages' `contextProjectIds`, even if the prompt budget trims history. Null/missing run lineage, malformed IDs, or a union exceeding 100 projects suppress capture and deny body reads; known empty `[]` remains distinct from unknown. Never reconstruct this provenance from a run's current scope. Legacy non-run body gates and the unscoped-worker prohibition remain in place. The runner carries a project id when its scope has exactly one project.
- `ai.request` body expiry clears body fields while preserving standard metadata until normal retention. Verbose-only events still expire as rows. Overflow chooses a stable cutoff under the prune lock, preserving the row floor across concurrent pruners without repeated counts.
- Writer ticks refresh stale settings independently of traffic; other processes observe changes within the 15-second cache bound plus one tick. `trackDiagnosticTask` owns capture cancellation on shutdown. Correlation UUIDs are validated and varchar fields capped before insertion.
- Settings bounds are shared by core, web, forms and tools. Diagnostic cursors reuse `adminPaging`; tools budget the full envelope with `pagedOutput`. Filter indexes live in `20260914000300_diagnostic_filter_indexes`.
- Each runtime publishes bounded writer counters in `SystemSetting` every 15 seconds and at shutdown; the page labels remote snapshots as last reported. Statistics share one aggregate count per process/cache interval.

## External provider body suppression

`DiagnosticContext.suppressProviderBodies` composes monotonically: nested scopes
and bound callbacks cannot relax an outer true value. `diagnosticFetch` snapshots
it before asynchronous work and never clones/reads either body when suppressed.
`bodyProjectIds` likewise unions across scopes, callbacks and event inputs, with
unknown lineage dominating; context snapshots copy and freeze known IDs. The
writer rechecks both privacy fields before persisting either body.
Failure diagnostics use closed error classifications; independent request metadata
and separately emitted token usage remain available. External assistant/task
runners must enter this context before provider calls, including replay of known
external-source history. Do not derive model/usage metadata by reading suppressed bodies.

## External lifecycle diagnostics

`services/externalMcp/diagnostics.ts` queues allowlisted call/approval metadata in
`externalTransaction` and emits only after the enclosing transaction commits.
Pass its explicit queue through approval invalidation and assistant settlement;
never emit from a transactional helper. Only accepted transitions emit. Events are
`external.call.prepared`, `external.call.dispatched`, `external.call.settled`,
`external.approval.changed`, and `external.discovery.completed`. Include IDs,
policy/revision, status, safe error code and byte/duration counts, never names,
endpoints, arguments, results, or raw exceptions. Unknown certainty remains separate
from the cause code. Failed discovery emits after its failure summary commits.
