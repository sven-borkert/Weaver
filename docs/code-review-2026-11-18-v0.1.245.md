# Weaver code review · 0.1.245

Reviewed the `main` snapshot at `ffff57e96e23cd4d9d3cf6f51253908ccc48604a` on November 18, 2026. This report covers the application as a whole. The earlier review on the same date covered 0.1.241, and its findings have a separate resolution record. [Previous report](code-review-2026-11-18.md) · [Resolution record](IMPLEMENTATION.md#november-18-application-review-fixes)

## Highest priorities

1. **Preserve unsaved Outside Git drafts when a session expires.** A background query can unmount the only copy of the user's changes while the sign-in banner tells them to keep the tab open.
2. **Bind a document replacement to its committed UUID at the point of writing.** The project API can proceed after it fails to repair a stale database path. A commit SHA shared by two files cannot distinguish them.
3. **Restore the nightly database test signal.** The workflow omits a required test key. All four Outside Git integration cases failed in setup with the workflow's environment.

The review found 26 issues. Two are P1, 22 are P2, and two are P3. P1 denotes a path to lost user work or corruption of live content. P2 denotes a material correctness, access-control, or operational failure. P3 denotes a narrower reporting or presentation defect. Findings without an execution result below are based on tracing the current source and its callers.

## Content integrity and access

### 01 · P1 · Session expiry can discard an Outside Git draft

The editor keeps its title and Markdown in component state. An authorization error on a project or folder-list refetch replaces the entire screen. The document-detail query can independently replace the editor. A user who returns to a dirty tab after their session expires can therefore lose the draft before signing in again. The navigation guard cannot prevent React from unmounting a component. Preserve the dirty draft for the same signed-in identity, suspend writes until access is re-established, and clear it on account changes. Test a dirty title and body through a 401 on each query and same-user sign-in. [Screen and list](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/LocalDocumentsScreen.tsx#L57>) · [Detail query](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/LocalDocumentsScreen.tsx#L443>) · [Draft state](<../apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/LocalDocumentEditor.tsx#L105>) · [Session recovery promise](../apps/web/src/trpc/react.tsx#L66)

### 02 · P1 · Document replacement can write to a different document after projection repair fails

The project API resolves the requested UUID and revision in Git, then attempts to repair the database row used by the writer. Repair can return `null` when it cannot project the committed file. For example, the snapshot reader accepts a title that exceeds the projection's length limit. Replacement ignores the return value and takes its destination from the old database row. If a Git commit moved the requested document and changed the document now occupying its old path, both paths can share the same last-change SHA. The SHA check can then pass for the wrong file. The writer takes metadata from that file and writes the requested row's UUID and replacement body there. The wrong document's live contents are lost until restored from history. [API snapshot](../packages/core/src/projectApi/snapshots.ts#L112) · [Repair result ignored](../packages/core/src/projectApi/operations.ts#L535) · [Projection validation](../packages/core/src/services/documents.ts#L743) · [Repair fallback](../packages/core/src/services/documents.ts#L1996) · [Path and revision check](../packages/core/src/services/documents.ts#L1421) · [Written UUID](../packages/core/src/services/documents.ts#L1486)

Require successful repair at the resolved path and check the committed file's UUID under the repository lock immediately before mutation. Move and delete already use a shared identity check. A regression should preserve both blobs and HEAD when path repair fails and two paths share a revision. [Existing identity check](../packages/core/src/services/documents.ts#L2529)

### 03 · P2 · Queued document writes can outlive the editor's membership

Save and delete authorize the editor before waiting for the repository lock. Membership removal commits independently, then synchronizes project metadata to Git. A save or delete admitted before removal can acquire the lock afterward and commit with the old authority. Recheck the role inside the locked operation, as document creation already does. Cover a queued write whose actor loses membership before the write begins. [Save](../packages/core/src/services/documents.ts#L1832) · [Write lock](../packages/core/src/services/documents.ts#L1547) · [Delete](../packages/core/src/services/documents.ts#L2688) · [Membership removal](../packages/core/src/services/projectMembers.ts#L292) · [Creation check](../packages/core/src/services/documents.ts#L1573)

### 04 · P2 · A stale personal API-key form can restore removed grants

Saving a rename submits the form's entire capability set and project list. The service checks the key ID and owner, replaces permissions, and recreates project grants. If the owner restricts the key in another tab, the older form can silently undo that change. Compare a dedicated policy revision on save and return a conflict on mismatch. Test a rename from a form opened before a restriction. The prior review fixed the separate project-owned key editor. [Personal key form](<../apps/web/src/app/(workspace)/account/api-keys/_components/EditApiKeyDialog.tsx#L115>) · [Policy replacement](../packages/core/src/services/apiKeys.ts#L353)

### 05 · P2 · Password changes and resets can exhaust the connection pool they need

`DATABASE_POOL_MAX=1` is supported. The credential lock opens a Prisma transaction and holds its connection while invoking a callback. An admin reset opens a second transaction on the same client. Self-service change calls Better Auth on that client and then opens another transaction for credential cleanup. With one connection, the nested work must wait for the transaction that is waiting for it. An authenticated user can get stuck on the required password-change screen and lose access to the workspace. Keep serialization on a dedicated connection or let the database work share one transaction. Verify both flows with a one-connection pool and concurrent operations on a small pool. [Pool configuration](../packages/config/src/server.ts#L89) · [Lock and self-service change](../packages/core/src/services/users.ts#L446) · [Admin reset](../packages/core/src/services/users.ts#L519) · [Auth client wiring](../apps/web/src/server/auth/index.ts#L20)

### 06 · P2 · Failed preconditions do not retain the machine API's idempotency key

The published contract promises to retain a deterministic 412 and reject a changed request under the same key with 409. The mutation checks `If-Match` before inserting its operation record. A stale precondition therefore leaves the key free, and a different request using the updated revision can succeed with it. Record the admitted request and its deterministic outcome under the operation lock, preserving the existing retry behavior for transient failures and live authorization on replay. Cover an unchanged retry and a changed retry following a 412. [HTTP contract](api/project-machine-api.md#L155) · [Precondition and reservation order](../packages/core/src/projectApi/operations.ts#L479)

## Git, wiki and search

### 07 · P2 · Document history can attribute another document's commits to the current UUID

History follows the projected path and paginates its Git log without checking the UUID stored in each historical file. A reused path can therefore show another document's author, message, and change summary. In a database-backed run of the existing reused-path fixture, history returned three entries, including the foreign revision, while diff and restore rejected that revision. Resolve the requested identity in the snapshot and filter historical entries before pagination, as table history does. Extend the existing reused-path fixture to assert the displayed history and its page boundary. [Document history](../packages/core/src/services/documents.ts#L1878) · [Table history](../packages/core/src/services/tables.ts#L2317) · [Existing fixture](../apps/web/tests/integration/documents.spec.ts#L3100)

### 08 · P2 · Git pull cannot resolve collisions on valid long table names

Normal table creation allows an 80-character slug and shortens its stem to make room for a numeric suffix. Pull appends `-2` to the entire slug when two different tables collide. A 79- or 80-character slug then fails path validation, aborting every retry of that pull. Share the bounded allocation rule and test independently created tables at both lengths, including an already occupied suffix. [Pull allocator](../packages/core/src/services/projectGitRemoteMerge.ts#L248) · [Path validation](../packages/core/src/tables/paths.ts#L24) · [Normal allocator](../packages/core/src/services/tables.ts#L1041)

### 09 · P2 · A cancelled wiki revert can still change input records

After the page operations finish, the worker updates the report by revert ID and marks processed inputs from the source run as reverted. Neither write checks the lease. It then attempts a separate lease-checked transition and emits a success event even if that transition did nothing. Cancellation or lease replacement between those steps can leave a cancelled run with changed inputs or allow an old worker to replace its successor's report. Check the active lease and commit the report, input transitions, and terminal status together. Emit success only for the winning transaction. Test cancellation immediately before finalization. [Revert finalization](../packages/core/src/services/wikiRevert.ts#L566) · [Conditional terminal transition](../packages/core/src/services/wikiRuns.ts#L94) · [Cancellation](../packages/core/src/services/wikiRuns.ts#L228)

### 10 · P2 · Paging the wiki change feed can skip a merged branch

Without a `since` date, the next page starts a new Git walk from the next commit SHA. Once that SHA is on one parent of a merge, commits reachable only through the other parent disappear from subsequent pages. Bind the cursor to the original tip and position in its traversal. Walk a two-parent merge with a page size of one and compare all returned SHAs with a single unpaged walk. [Feed cursor](../packages/core/src/services/wikiReads.ts#L328) · [Git traversal](../packages/git-store/src/gitStore.ts#L1571)

### 11 · P2 · One long document can crowd other documents out of semantic search

A request for two documents takes the nearest 160 chunk vectors before reducing them to one row per document. A supported document can contribute up to 256 chunks. If its chunks occupy those 160 places, a second semantically relevant document can be omitted. A query with no lexical matches then returns only one document. Expand the candidate window when too few distinct live documents survive, subject to an explicit search budget. Test a second semantic-only document behind 160 chunks from the first. [Result budget](../packages/core/src/services/search.ts#L141) · [Chunk selection](../packages/core/src/services/search.ts#L533) · [Document selection](../packages/core/src/services/search.ts#L598) · [Chunk limit](../packages/core/src/knowledge/chunking.ts#L44)

## Assistant, scheduled tasks and peer connections

### 12 · P2 · Assistant Send can report an already committed message as unsent

The service commits the user message and queued run, then waits for publication and the job-ID write before returning. An exception in either step leaves the composer showing an error and retaining the draft. Reconciliation can deliver the original run, so sending the draft again after completion can create a second model run. Return the committed run ID, record dispatch errors, and let reconciliation retry. Exercise a queue acknowledgement followed by a failed receipt write and assert one visible message and run. [Commit and dispatch](../packages/core/src/services/assistantRuns.ts#L192) · [Job-ID write](../packages/core/src/services/assistantRuns.ts#L108) · [Reconciliation](../packages/core/src/services/assistantRuns.ts#L1134) · [Composer](../apps/web/src/components/assistant/Composer.tsx#L37)

### 13 · P2 · A Unicode character at a streaming boundary can fail an assistant reply

The assistant flushes buffered text in chunks of 400 UTF-16 units by default. A slice can end with the first half of an emoji. The runner then attempts to persist that malformed chunk as a JSONB event. With a mock provider returning 399 ASCII characters followed by an emoji and one more letter, the database-backed run ended `failed` with error code `INTERNAL`, zero text deltas, and no assistant reply. Split on whole code points and carry a trailing high surrogate into the next delta. Verify that the stored events replay to the complete original answer for a character spanning both a provider chunk and a persistence boundary. [Chunking](../packages/ai/src/runner.ts#L541) · [Event storage](../packages/core/src/services/assistantRuns.ts#L93)

### 14 · P3 · A filtered provider response can become a successful, empty reply

The stream runner handles output-length and tool-step limits explicitly. In a database-backed run, a mock provider that ended with `content-filter` and no text produced a completed run and a zero-character assistant message. Surface a filtered-response outcome and account for any tokens already consumed. Cover a stream that finishes this way without emitting an error event. [Finish handling](../packages/ai/src/runner.ts#L766) · [Message completion](../packages/core/src/services/assistantRuns.ts#L652)

### 15 · P2 · Scheduled reports accept an output document they cannot update

The target picker includes Python documents, and admission omits the target's document kind. The runner calls the model, then always sends Markdown to a writer that rejects content of a different kind. A valid-looking schedule can consume repeated model calls and reach the automatic pause threshold without publishing a report. Filter the picker, reject incompatible targets on create and edit, and check existing tasks before generation. Test both a new Python target and a previously saved one. [Target picker](<../apps/web/src/app/(workspace)/projects/[projectId]/tasks/_components/TaskDialog.tsx#L630>) · [Admission](../packages/core/src/services/scheduledTasks.ts#L374) · [Report write](../packages/ai/src/taskRunner.ts#L236) · [Kind guard](../packages/core/src/services/documents.ts#L1414)

### 16 · P2 · A confirmed peer transfer can appear to fail and be sent twice

After validating the resource ID returned by the destination, Weaver waits for a local `lastUsedAt` update. A transient database error discards that known receipt. The send dialog offers a retry, and the receiver creates a new document or table on each accepted send. Return the confirmed destination and record timestamp-update failures separately. Test a successful peer response followed by a local timestamp write failure. [Transfer response](../packages/core/src/services/remoteInstances/transfer.ts#L493) · [Timestamp write](../packages/core/src/services/remoteInstances/connections.ts#L468) · [Receiver](../packages/core/src/services/remoteInstances/receive.ts#L168)

### 17 · P2 · Outbound MCP calls can leave stateful server sessions open

Each catalog refresh and tool execution opens a transport. Weaver's close handler aborts the local controller and calls the SDK client's `close()`. In the pinned client, that closes local requests. Server-side HTTP session release is a separate `terminateSession()` operation. A stateful peer that keeps sessions until expiry can exhaust its quota across successful requests. Attempt bounded remote termination when a session was assigned, tolerate peers without that operation, and preserve the completed call's result. Test repeated discovery and calls against a peer that counts live sessions. [Connection lifecycle](../packages/external-mcp/src/client.ts#L246) · [Catalog](../packages/core/src/services/externalMcp/catalog.ts#L127) · [Tool execution](../packages/core/src/services/externalMcp/execution.ts#L236) · [Pinned client](../packages/external-mcp/package.json)

## Exams, imports and rendering

### 18 · P2 · A debounced exam edit can silently overwrite another tab's answer

The browser increments the proposed answer sequence on every keystroke. The server accepts any higher sequence. Starting at 8, one tab can save 9 while a second tab buffers two edits and sends 10, without ever observing 9. Both saves succeed and the second replaces the first without presenting the conflict UI. Send the acknowledged server revision separately from the local edit counter. Test diverging tabs with different numbers of buffered edits and retain idempotent handling for a lost acknowledgement. [Client counter](<../apps/web/src/app/(workspace)/projects/[projectId]/exams/attempts/[attemptId]/_components/useAutosaveAnswers.ts#L55>) · [Debounce](<../apps/web/src/app/(workspace)/projects/[projectId]/exams/attempts/[attemptId]/_components/useAutosaveAnswers.ts#L269>) · [Conditional write](../packages/core/src/services/examAttempts.ts#L358)

### 19 · P2 · Returning an exam to draft hides existing trainee results

The Results view derives attempts from the current exam catalog. Returning an exam to draft through the trainer's `update_exam` tool removes it from that catalog, hiding its released results and the catalog's link to an ongoing attempt. A rename also changes historical titles in Results even though attempt detail uses the saved snapshot. List the trainee's attempts independently of the catalog and use their snapshot titles. Cover a published exam renamed and then returned to draft after an attempt was released. [Trainer tool](../packages/assistant-tools/src/tools/exams/write.ts#L88) · [Status update](../packages/core/src/services/exams.ts#L432) · [Catalog filter](../packages/core/src/services/exams.ts#L489) · [Results view](<../apps/web/src/app/(workspace)/projects/[projectId]/exams/_components/ExamResultsScreen.tsx#L12>) · [Snapshot title](../packages/core/src/services/examAttempts.ts#L141)

### 20 · P2 · Cleanup failures can turn a completed deletion into an error response

Artifact deletion commits the row removal before unlinking the blob and sweeping notebook data. Import batch deletion also commits first, then opens another transaction to reclaim files. A filesystem or database failure during reclamation therefore reports failure to the user, while a retry finds the item already gone. Return the logical deletion result, record pending cleanup, and let the existing sweeps reclaim storage. Test a cleanup failure after commit and verify both the response and eventual cleanup of unreferenced files. [Artifact deletion](../packages/core/src/services/artifacts.ts#L566) · [Batch deletion](../packages/core/src/services/ingestion.ts#L1182) · [Notebook sweep](../packages/core/src/services/artifactNotebookJobs.ts#L475)

### 21 · P2 · An oversized OneNote table can empty an otherwise readable page

The native reader builds a table as one block. To meet the 2 MiB page limit, it repeatedly drops the final block. When a leading table alone exceeds the limit, every later paragraph is discarded before the table itself is removed. Meanwhile, the manifest retains search text collected before truncation, so a search can point to a page with no visible blocks. Budget table rows or cells during extraction and derive searchable text from what the reader can display. Test an oversized first table followed by a short paragraph. [Table extraction](../packages/ingestion/native/onenote-reader/src/lib.rs#L579) · [Final truncation](../packages/ingestion/native/onenote-reader/src/lib.rs#L844) · [Manifest text](../packages/ingestion/native/onenote-reader/src/lib.rs#L469)

### 22 · P3 · Import analysis and OCR can omit known model usage

Both error handlers record empty usage even when the provider error carries token counts. Cancellation can also discard a returned response before its usage is saved. This understates usage for completed or billed calls that produce no accepted output. Recover counts from provider errors, as the task runner does, and record returned usage once before discarding a cancelled result. Cover both paths with provider doubles carrying known counts. [OCR](../packages/ingestion/src/ocr.ts#L128) · [Analysis](../packages/ingestion/src/analyzeStage.ts#L224) · [Existing usage recovery](../packages/ai/src/usage.ts#L63)

### 23 · P2 · Math plots draw false lines across off-grid singularities

The sampler checks explicit division denominators only for Cartesian y-expressions. Parametric reciprocals and native tangent can have finite samples on opposite sides of a pole. The renderer joins them through the visible range. Running the sampler and renderer for `tan(x)` on `[0, 3]` with y bounded to `[-2, 2]` produced adjacent values around +303 and −238 and a stroke crossing the axis near π/2. Track discontinuities against the independent variable for tangent and both parametric coordinates. Compare equivalent Cartesian and parametric curves and check the static PDF renderer as well. [Expression evaluation](../packages/core/src/editor/plot-expression.ts#L34) · [Sampling](../packages/core/src/editor/plot-spec.ts#L341) · [SVG path](../apps/web/src/lib/editor/plot-render.ts#L247)

## CI and deployment

### 24 · P2 · The scheduled database integration workflow omits its test encryption key

The workflow generates an auth secret and writes the database settings. Most router callers also require `WEAVER_ENCRYPTION_KEYS` when constructing the test context. On a freshly migrated disposable database, the workflow's environment caused all four Outside Git integration tests to fail in setup with the missing-key error. With a generated test key, all four passed. Generate a versioned, random 32-byte encryption key in the job's test environment and exercise one real router caller in the workflow setup check. [Workflow environment](../.github/workflows/integration.yml#L54) · [Required test key](../apps/web/tests/integration/_harness.ts#L229) · [Caller construction](../apps/web/tests/integration/_harness.ts#L373)

### 25 · P2 · Retrying an unfinished older release can move all four latest tags backward

The publisher uses a completion marker per commit. An old release interrupted before its marker is written can resume after a newer release has finished. Its marker is still absent, so it republishes its own four digests to `latest`. Using the repository's registry double, I interrupted the first promotion, published the newer commit, and retried the older one. All four aliases moved back. Serialize promotion and verify the candidate is still eligible to advance the current release before changing any floating alias. Keep immutable-alias repair available on retries. [Promotion loop](../deploy/ci/build-images.sh#L205) · [Existing completed-release retry test](../scripts/ci-build-images.test.mjs#L351)

### 26 · P2 · Repeating a successful upgrade removes the cached rollback release

Cleanup preserves the target tag and the value read from `web.env` immediately before installation. When the host is already on the target revision, those two values are identical. Running the deploy-script double in that state selected all four images of the prior release for removal. Rollback then depends on registry availability despite the documented offline cache. Persist the last distinct successful release or skip rotation when the target is already active. Test upgrades A → B → B and retain both A and B. [Previous tag](../deploy/weaver-upgrade#L71) · [Image cleanup](../deploy/weaver-upgrade#L41) · [Rollback procedure](../deploy/README.md#L241)

## Scope and verification

The review sampled entry points and traced their callers across the three runtimes and eleven shared packages. It covered browser draft and query state, sessions and project membership, machine credentials, Git-backed and Outside Git content, tables, wiki history and recovery, assistant execution, provider accounting, background jobs, search and indexing, exams, ingestion, artifact readers, MCP transports, OIDC and peer transfer. Deployment coverage included the image publisher, Compose upgrade and backup scripts, and both CI configurations. The review prioritized user-visible behavior across component boundaries and prior fixes. It did not inspect every line or vendored dependency.

| Check                         | Result                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                   | Passed across 14 workspace tasks with two ESLint warnings.                                                                                    |
| `pnpm typecheck`              | Passed across 14 workspace tasks.                                                                                                             |
| `pnpm test --concurrency=1`   | Passed, including repository scripts, the mock AI server checks, and package unit tests.                                                      |
| `pnpm format:check`           | Passed for the reviewed snapshot.                                                                                                             |
| Targeted database integration | With the generated test key, all 45 existing cases passed across `localDocument.spec.ts`, `assistantRuns.spec.ts`, and `wikiRevert.spec.ts`.  |
| Focused checks on PostgreSQL  | Temporary cases in the disposable checkout observed the foreign history entry (07), failed Unicode reply (13), and empty filtered reply (14). |
| Release and upgrade scripts   | Executed with the repository's local doubles. Results are recorded in findings 25 and 26.                                                     |
| Math plotting                 | Executed the shared sampler and SVG renderer. Result is recorded in finding 23.                                                               |

Verification used Node 24.7.0, pnpm 12.14.0 and disposable checkouts of the reviewed commit. Database checks used isolated `weaver_test` and `./data-test` with PostgreSQL 18.7. The full integration suite, Playwright end-to-end suite, and live deployment were outside the executed checks.
