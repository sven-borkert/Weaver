# Weaver application code review

Reviewed on 14 November 2026 against commit `f78e9a3b8ed201f9e0504ce137bd6d4a0ed744cd`, application version `0.1.239`.

## Findings at a glance

The review identified **15 actionable findings: one P1, thirteen P2, and one P3**. The highest-priority issue can delete a different document from the one requested after a Git pull changes paths before database projections catch up. Other findings concern credential revocation, recovery evidence, lost edits, task scope, concurrency, classification, and resource limits.

| ID  | Priority | Finding                                                                        |
| --- | -------- | ------------------------------------------------------------------------------ |
| R1  | P1       | Document deletion can remove a different document after Git pull               |
| R2  | P2       | Personal API-key creation can race past account credential revocation          |
| R3  | P2       | Imported Git trailers can fabricate a successful MCP operation                 |
| R4  | P2       | Scheduled update reports overwrite edits made during generation                |
| R5  | P2       | Exam autosave recovery can mark an old cached answer as saved                  |
| R6  | P2       | Scheduled tasks ignore the selected folder focus                               |
| R7  | P2       | Concurrent task creation permits multiple writers for one output document      |
| R8  | P2       | Entity embedding repair can publish a stale vector that later repair skips     |
| R9  | P2       | Deleted-content pagination loses history on merged branches                    |
| R10 | P2       | Deleted-document recovery buffers historical assets without an aggregate limit |
| R11 | P3       | Two script test suites leave temporary fixtures behind                         |
| R12 | P2       | Adding a wiki note clears text entered while the request is pending            |
| R13 | P2       | Import review advances revision tokens while retaining stale form values       |
| R14 | P2       | Wiki classification reaping can fail a renewed preview or completed plan       |
| R15 | P2       | Protected task outputs can indefinitely starve wiki classification             |

P1 means a high-impact defect to address first; P2 means a concrete defect warranting a fix; P3 means lower-impact maintenance work. No application fixes were made during this review.

## Detailed findings

### R1 — P1: Document deletion trusts a stale projected path

**Location:** [documents.ts, lines 2628–2632](../packages/core/src/services/documents.ts#L2628-L2632).

`deleteDocumentInRepo` obtains a database row and immediately removes `row.path` and its assets directory. It never reads the committed document header to verify that this path still belongs to the requested document ID. `requireDocument` only reads the database projection ([lines 1265–1274](../packages/core/src/services/documents.ts#L1265-L1274)).

A supported Git pull can move local document A from `notes.md` to another slug and put remote document B at `notes.md`. The merge code performs that relocation ([projectGitRemoteMerge.ts, lines 505–550](../packages/core/src/services/projectGitRemoteMerge.ts#L505-L550)), then releases the repository lock before rebuilding projections ([projectGitRemoteJobs.ts, lines 666–686](../packages/core/src/services/projectGitRemoteJobs.ts#L666-L686)). A delete of A admitted in that interval still sees A → `notes.md` in PostgreSQL and deletes B and B's images. A remains in Git. A rebuild failure extends this window but is not required.

The repository lock serializes the two writes; it does not make the stale projection authoritative. The ordinary document reader already checks `meta.id === row.id` ([documents.ts, line 1641](../packages/core/src/services/documents.ts#L1641)), but deletion does not.

**Validation:** The actual deletion function was executed with a repository double containing B at `notes.md`, A at `notes-2.md`, and the stale A projection. It reported A deleted, removed B and B's asset, and left A present. The merge/rebuild ordering was independently inspected. This was not an end-to-end database/pull reproduction.

**Recommended correction:** Resolve the current committed path by document identity under the repository lock before deleting either content or assets. At minimum, reject an identity mismatch and require projection repair. Add a regression that pauses post-pull rebuilding and deletes the displaced document.

### R2 — P2: Personal key issuance can survive deactivation's revocation

**Location:** [apiKeys.ts, lines 206–230](../packages/core/src/services/apiKeys.ts#L206-L230).

`createApiKey` trusts the previously resolved session actor and calls the issuer without acquiring the user's credential lock or checking the persisted session again. In contrast, `deactivateUser` takes `weaver:user-credentials:<userId>`, bans the user, deletes sessions, and deletes personal keys in a transaction ([users.ts, lines 399–418](../packages/core/src/services/users.ts#L399-L418)).

An authenticated create request can pause before issuance, let deactivation finish, and then insert a new key after the deletion. The issuer uses a trusted, headerless Better Auth call ([auth/src/apiKeys.ts, lines 21–37](../packages/auth/src/apiKeys.ts#L21-L37)); Weaver's auth hook skips its session check when no cookie exists ([auth/src/index.ts, lines 252–253](../packages/auth/src/index.ts#L252-L253)). Reactivation only unbans the user, so the surviving key becomes usable again.

Live bearer checks prevent use while the account is banned. This finding concerns incomplete revocation across reactivation, not immediate access by a banned user.

**Validation:** A source-backed harness paused the actual service's issuer while executing deactivation against an in-memory database. One key was issued after the ban and survived revocation. Subsequent inspection of the installed `@better-auth/api-key` 1.7.2 implementation confirmed that headerless issuance accepts the supplied user ID without checking banned state or a live session. The real dependency's issuance path was inspected, not executed against a database.

**Recommended correction:** Serialize issuance and restriction persistence with the same credential lock. After admission, verify the persisted session, account state, and relevant live role. A request queued behind deactivation or credential reset must fail.

### R3 — P2: MCP recovery accepts untrusted execution evidence

**Location:** [contentOperations.ts, lines 666–671](../packages/core/src/services/contentOperations.ts#L666-L671).

`matchesRecoveryIdentity` requires `trustedAuthor` for wiki recovery, but the MCP branch only compares the request hash and tool name. The Git reader exposes trailers on untrusted imported commits too. MCP operation IDs and request hashes are deterministic, not secrets ([mcpOperations.ts, lines 126–136](../packages/core/src/services/mcpOperations.ts#L126-L136)).

Given a known request and idempotency key, imported history can contain a commit with matching operation, hash, and tool trailers. `recoverLifecycleOperation` accepts it ([contentOperations.ts, lines 779–800](../packages/core/src/services/contentOperations.ts#L779-L800)). For `folder_create`, it derives the reported path from the request without verifying that the commit created that folder ([lines 722–727](../packages/core/src/services/contentOperations.ts#L722-L727)). The MCP service then records this fabricated success and skips the intended write ([mcpOperations.ts, lines 237–274](../packages/core/src/services/mcpOperations.ts#L237-L274)).

This requires imported history and knowledge of the intended request; it does not bypass project membership or let an anonymous caller write content.

**Validation:** The actual identity and lifecycle-recovery functions accepted an untrusted commit, reported a `never-created` folder, and never inspected the commit's changes.

**Recommended correction:** Require locally trusted commits for MCP recovery, retaining operation/hash/tool matching. Validate lifecycle effects where they can be checked. Test recovery against both genuine locally recorded commits and forged imported trailers.

### R4 — P2: Scheduled update reports discard concurrent edits

**Location:** [taskRunner.ts, lines 206–225](../packages/ai/src/taskRunner.ts#L206-L225).

An `outputMode: "update"` task reads the target document for its prompt, but `readCurrentOutput` returns only text and a truncation flag, discarding its revision ([lines 144–160](../packages/ai/src/taskRunner.ts#L144-L160)). After generation, `writeOutput` rereads the target and supplies that new revision to the writer.

If the model reads version A, a user saves B during generation, and the model produces a revision of A, publication uses B's current SHA as its precondition and overwrites B. The run succeeds instead of reporting `OUTPUT_CONFLICT`.

The project lock and publication lease are correctly checked, but only at publication. They cannot detect edits made during the earlier model call when the expected revision has already been replaced with the latest one. Git history retains the overwritten content, but the live document loses the user's changes.

**Validation:** Manually traced prompt assembly, generation, the publication lock, and the writer's expected-revision argument. No provider or database run was performed.

**Recommended correction:** Preserve the output identity and revision used for generation and validate them at publication. A changed update target should produce `OUTPUT_CONFLICT`, leaving the current document intact.

### R5 — P2: Exam autosave recovery can acknowledge an obsolete cached answer

**Location:** [useAutosaveAnswers.ts, lines 134–156](<../apps/web/src/app/(workspace)/projects/[projectId]/exams/attempts/[attemptId]/_components/useAutosaveAnswers.ts#L134-L156>).

When the server returns `outcome: "stale"`, the hook calls `utils.exam.getAttempt.fetch` without invalidation or `staleTime: 0`, then replaces the answer with that result and marks it saved. The application's query client treats data as fresh for 30 seconds ([query-client.ts, line 14](../apps/web/src/trpc/query-client.ts#L14)). tRPC's helper delegates to `fetchQuery`, which may return this cached data instead of making a request. These behaviors are documented by [tRPC](https://trpc.io/docs/client/react/useUtils) and [TanStack Query](https://tanstack.com/query/v5/docs/reference/QueryClient#queryclientfetchquery).

A single-tab reproduction is sufficient: load answer sequence 8, save sequence 9, lose the response after the server commits, then retry. The server correctly returns stale for the equal sequence. The recovery fetch can return cached sequence 8, replace the visible answer, and allow `flush()` to resolve. Later edits continue from the wrong sequence. Concurrent tabs can trigger the same defect.

**Validation:** Executed the actual hook code with a lost-response mutation double and a fresh-cache fetch double. The server held sequence 9 / `new answer`; the browser reverted to sequence 8 / `old answer`, marked it `saved`, and resolved `flush()`. The server's sequence guard was independently checked.

**Recommended correction:** Force a fresh recovery read and verify its sequence is at least the server-reported sequence before acknowledging it. Preserve pending local edits and retain an error state if that refresh fails. Exercise the real query cache in a regression test; the existing fetch mock always supplies canonical data and misses this failure.

### R6 — P2: Scheduled tasks read outside the selected folder focus

**Location:** [scheduledTasks/context.ts, lines 432–484](../packages/core/src/scheduledTasks/context.ts#L432-L484).

Task creation accepts folder focus through the shared scope selector and persists its path and resource type. Context assembly only has special branches for document and table focus. A folder falls into the project-wide branch, which selects recent documents and tables without using `folderPath` or `folderResourceType`.

A task focused on one document folder can receive unrelated documents; a table-folder focus can receive documents first. Recent unrelated material can consume the budget before anything in the chosen folder is included. The task dialog explicitly promises that focus can restrict reads to a folder ([TaskDialog.tsx, lines 511–525](<../apps/web/src/app/(workspace)/projects/[projectId]/tasks/_components/TaskDialog.tsx#L511-L525>)).

Live project membership remains enforced. This is incorrect scope selection and unexpected provider disclosure within an accessible project, not cross-project access escalation.

**Validation:** Traced the selector, scope schema/resolver, saved task scope, and both context-selection branches.

**Recommended correction:** Apply the chosen folder subtree and resource type to content and change-digest selection, preserving paging and budget limits. Test both document-folder and table-folder tasks with newer material outside the selected subtree.

### R7 — P2: The single-task output rule is not concurrency-safe

**Location:** [scheduledTasks.ts, lines 350–361](../packages/core/src/services/scheduledTasks.ts#L350-L361), [lines 600–633](../packages/core/src/services/scheduledTasks.ts#L600-L633).

`resolveOutputTarget` rejects another task targeting the same document using a regular `findFirst`. Creation performs this lookup before entering its transaction. Two requests can both observe no other writer and then both create a task for that document.

The owner/project quota locks run afterward and do not repeat the destination check. The schema and migrations contain only a non-unique output-document index ([schema.prisma, line 1586](../packages/db/prisma/schema.prisma#L1586)). Independently leased tasks can therefore replace the same output, contrary to the explicit one-task-per-document contract.

**Validation:** Traced create/update target validation, quota admission, insertion, task lease identity, and schema/migration constraints. No concurrent database test was run.

**Recommended correction:** Enforce uniqueness for non-null output document IDs in PostgreSQL and translate collisions into the existing conflict response. Test concurrent creates and retargeting, including requests from different owners.

### R8 — P2: Embedding repair can republish a stale entity vector

**Location:** [knowledgeEnrichment.ts, lines 1026–1045](../packages/core/src/services/knowledgeEnrichment.ts#L1026-L1045); the same issue appears at [lines 1103–1121](../packages/core/src/services/knowledgeEnrichment.ts#L1103-L1121).

Repair stages an embedding, rereads the entity's text hash in its final transaction, then inserts the vector. That final hash read is an ordinary `findMany`; neither publisher acquires the project/entity lock used by invalidators.

Under the default transaction isolation, the following interleaving is possible: repair validates description A; a concurrent document change updates the entity to B and deletes its vector; that transaction commits; repair inserts its staged vector for A. `refreshEntityDescriptions` performs the update/deletion ([knowledgeEntityDescriptions.ts, lines 73–100](../packages/core/src/services/knowledgeEntityDescriptions.ts#L73-L100)). Missing-vector repair uses `NOT EXISTS`, so the incorrectly present vector is no longer selected for repair.

The production caller has already completed its readiness transaction before invoking repair ([knowledgeGenerations.ts, lines 914–916](../packages/core/src/services/knowledgeGenerations.ts#L914-L916)). There is no enclosing lock protecting this publication. Main extraction publication does take the compatibility/project lock; these repair paths omit it.

**Validation:** Manually traced production callers, transaction boundaries, invalidation locks, hash reads, insertion, and missing-vector selection. This is an explicit concurrency analysis, not a database stress-test result.

**Recommended correction:** Hold the established project serialization lock during final validation and insertion, in the existing lock order. Recheck generation and live provenance there. Add an interleaving test that changes the entity between staging and publication.

### R9 — P2: Recovery pagination drops sibling branch history

**Location:** [contentRecovery.ts, lines 148–155](../packages/core/src/services/contentRecovery.ts#L148-L155).

The deleted-content cursor records the last scanned SHA and resumes by calling `logChangesBefore(after)`. That helper runs `git log <after>` ([gitStore.ts, lines 1521–1536](../packages/git-store/src/gitStore.ts#L1521-L1536)). A SHA is a valid continuation of a linear ancestry walk, but it does not retain the traversal frontier of a merged history.

For example, base contains A; the left branch deletes A; the right branch creates and deletes B; the branches merge with both absent. A full traversal can visit merge → left-delete-A → right-delete-B → right-create-B → base. With a page limit of one, the first page returns A. Restarting at left-delete-A visits only that commit and base, so B never appears on subsequent pages.

The snapshot SHA in the cursor does not help because the continuation traversal starts from `after` instead. Within-commit offsets handle multiple changes in one commit but not sibling ancestry.

**Validation:** Reproduced the divergent traversal with an ephemeral Git repository, which was removed afterward; independently checked the caller and Git arguments.

**Recommended correction:** Resume a deterministic traversal anchored at the original snapshot, with a position/frontier that preserves all remaining commits. Add a two-parent merge regression and test both page-size and scan-limit boundaries.

### R10 — P2: Deleted-document recovery has no total asset budget

**Location:** [contentOperations.ts, lines 1377–1404](../packages/core/src/services/contentOperations.ts#L1377-L1404).

`deletedDocumentAssets` reads every tracked file below the historical assets directory and retains every buffer in an array before calling the writer. Its only bound is the 50 MiB per-blob read limit. It does not apply a file-count or aggregate-byte limit, and it includes unreferenced historical assets.

Documents can accumulate assets through individually bounded uploads. Recovering a deleted document with many such assets can therefore allocate hundreds of megabytes or more while holding the project repository lock. The analogous version-restore implementation checks both `MAX_IMPORTED_IMAGES` and `MAX_IMPORT_IMAGE_BYTES` before buffering ([documents.ts, lines 2428–2443](../packages/core/src/services/documents.ts#L2428-L2443)): 100 images and 64 MiB in [documents/limits.ts](../packages/core/src/documents/limits.ts).

**Validation:** Inspected the deleted-restore call chain and writer, compared version-restore bounds, and checked the individual image-upload path. A harness executing the actual `applyOperationInRepo` recovery path with repository/database doubles reached its 101st historical asset read without a count rejection; it stopped before mutation. No large-memory or denial-of-service experiment was performed.

**Recommended correction:** Preflight file counts and blob sizes, enforce an aggregate budget and configured per-image cap before reading bytes, and reject over-budget recovery with a controlled error. Prefer recovering only needed assets where compatible with recovery semantics.

### R11 — P3: Script tests leak their temporary directories

**Location:** [backup-script.test.mjs, lines 101–140](../scripts/backup-script.test.mjs#L101-L140), [ci-build-images.test.mjs, lines 15–42](../scripts/ci-build-images.test.mjs#L15-L42).

Both helpers call `mkdtempSync` and create executable stubs/logs but register no cleanup. The backup cases also leave generated backup files. Every script-suite execution accumulates these directories, including failed test runs. The adjacent upgrade tests already demonstrate `t.after(() => rmSync(...))` cleanup.

**Validation:** Ran script tests inside a parent temporary directory with guaranteed cleanup. Before removing that parent, 11 `weaver-ci-*` and two `weaver-backup-test-*` fixture directories remained, in addition to a Node compile cache. All were removed by the enclosing cleanup. These fixtures were small in this run; this finding does not attribute earlier large disk usage to them.

**Recommended correction:** Register cleanup immediately after each fixture directory is created, or use `try/finally` around the helper. Verify cleanup on assertion and subprocess failures as well as success.

### R12 — P2: Wiki note submission discards subsequent typing

**Location:** [WikiInputScreen.tsx, lines 124–128](<../apps/web/src/app/(workspace)/projects/[projectId]/wiki/_components/WikiInputScreen.tsx#L124-L128>).

The add-text mutation's success handler unconditionally calls `setNote("")`. The textarea remains editable while the request is pending; only the Add button is disabled ([lines 278–290](<../apps/web/src/app/(workspace)/projects/[projectId]/wiki/_components/WikiInputScreen.tsx#L278-L290>)).

Submit note A, then start typing note B before the request returns. The server receives the snapshot of A captured by `mutate`, but A's success callback clears the current input, including B. The newer text was never submitted and has no recovery copy.

**Validation:** Two reviewers independently traced the mutation callback, controlled textarea state, and pending-state controls. No browser interaction was performed.

**Recommended correction:** Either disable editing during submission or retain a submitted-input revision and clear only if the current draft still matches it. Test a successful response arriving after a new edit.

### R13 — P2: Import review pairs stale fields with a newer revision

**Location:** [ReviewScreen.tsx, lines 275–300](<../apps/web/src/app/(workspace)/projects/[projectId]/imports/_components/ReviewScreen.tsx#L275-L300>).

`ReviewForm` initializes React Hook Form with `defaultValues`, but a refetched `file.draft` does not reset those values. Its React key depends only on file ID and status ([lines 175–200](<../apps/web/src/app/(workspace)/projects/[projectId]/imports/_components/ReviewScreen.tsx#L175-L200>)). Meanwhile, both save and accept read the revision directly from the latest `draft` prop.

Reviewer A opens revision 1 and edits it; reviewer B saves revision 2. A's first save correctly conflicts, but the handler only invalidates the query ([lines 214–223](<../apps/web/src/app/(workspace)/projects/[projectId]/imports/_components/ReviewScreen.tsx#L214-L223>)). After refetch, the form still contains A's revision-1 fields while `expectedRevision` becomes 2. A's next save now passes the server's revision guard and overwrites B's changes. A background refetch can create the same mismatch without an initial conflict. A clean form can also accept a revision whose changed metadata was never displayed.

The only explicit reset happens after this form's own successful update ([lines 236–240](<../apps/web/src/app/(workspace)/projects/[projectId]/imports/_components/ReviewScreen.tsx#L236-L240>)). The server correctly validates the supplied revision under its file lock; the client has detached that token from the values actually reviewed.

**Validation:** Independently traced component identity, form initialization/reset, invalidation, save payload, acceptance helper, and server revision checks. Existing component tests use a fixed draft revision and do not exercise a refetch with changed props. No live two-browser test was performed.

**Recommended correction:** Keep the form's baseline revision with its initialized values. Reconcile a newer server draft explicitly before advancing that baseline, preserving unsaved local edits. Test conflict/refetch/retry and acceptance after a background revision change.

### R14 — P2: Classification reaping fails work that has recovered

**Location:** [wikiClassify.ts, lines 569–580](../packages/core/src/services/wikiClassify.ts#L569-L580).

The reaper scans for expired preview leases. On the third attempt, it calls `endRun` using only the run ID and expected `preparing` status. It does not pass the observed lease token or recheck expiration. `endRunInTx` adds a token predicate only when the caller supplies one ([wikiRuns.ts, lines 95–100](../packages/core/src/services/wikiRuns.ts#L95-L100)).

Between the scan and transition, a heartbeat can renew the lease. Alternatively, the worker can finish and store a valid plan, clearing its token while leaving the run `preparing` for owner approval ([wikiClassify.ts, lines 372–389](../packages/core/src/services/wikiClassify.ts#L372-L389)). Both rows still match the reaper's terminal update and become `failed / LEASE_LOST`. The completed plan can no longer be accepted. The earlier-attempt branch already guards both token and expiry ([lines 585–592](../packages/core/src/services/wikiClassify.ts#L585-L592)).

**Validation:** A harness executing the actual reaper and terminal-transition bodies with Prisma doubles reproduced both interleavings: a renewed lease and a newly stored plan were each failed. The coordinator independently checked heartbeat, plan storage, and transition predicates. No database race test was run.

**Recommended correction:** Make the terminal transition conditional on the observed token and still-expired lease inside the transaction. Recheck under the appropriate row lock or use an atomic conditional update, preserving the existing end-of-run bookkeeping.

### R15 — P2: Protected documents exhaust the classification candidate window

**Location:** [wikiClassify.ts, lines 90–117](../packages/core/src/services/wikiClassify.ts#L90-L117).

Candidate loading selects the first `limit + 20` documents, ordered by path, and only afterward removes task outputs and the wiki guide. The default limit is 100. There is no continuation scan to replace excluded rows.

If 120 earlier-sorting task output pages lack wiki properties, an eligible page later in the sort order is never examined. Every classification attempt returns an empty candidate list and stops with `no_candidates` ([wikiClassifyPreview.ts, lines 147–159](../packages/ai/src/wikiClassifyPreview.ts#L147-L159)). Protection includes historical task-run outputs ([wikiClassify.ts, lines 64–80](../packages/core/src/services/wikiClassify.ts#L64-L80)), so the current-task quota does not bound the number of excluded pages. Without changing that content, repeated classification attempts cannot progress.

**Validation:** Executed the actual candidate-loading and protection helpers with database doubles containing 120 protected historical outputs plus one eligible later page. Zero candidates were returned. Independently checked task output creation, the protection queries, and the preview's stop behavior.

**Recommended correction:** Exclude protected IDs before applying the SQL limit, or keyset-scan additional rows until the eligible-page cap or end of the project is reached. Test a protected prefix larger than the entire initial window.

## Coverage and method

The coordinator and three parallel reviewers inspected production code, followed callers and authorization/transaction boundaries, and cross-checked suspected defects. Tests were supporting evidence. Each major application area received a review pass; this was not a line-by-line audit of every file or third-party dependency.

| Area                             | Source coverage                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication and authorization | Auth factory, credential user/bootstrap, sessions, password changes, personal keys, OAuth/DPoP, consent revocation, OIDC, security context, bearer resolution, user administration, project access/membership and personal workspaces                                                                         |
| Public and machine interfaces    | Central tRPC/auth transport, project API admission/policy/publishing/idempotency, inbound MCP gate/server/tool execution and HTTP/node runtime, representative route/schema adapters                                                                                                                          |
| External integrations            | Personal outbound MCP connection/catalog/authorization/approval/dispatch; peer registry/OAuth refresh/send/receive/callbacks; LLM connection/model/routing/decryption; diagnostic reads/settings, writer/context/sanitization and retention                                                                   |
| Git-backed content               | Advisory locks, committed reads/writes/trust/recovery, documents/folders/tables, pull/merge/push, lifecycle operations, deletion/history/restoration and projection synchronization                                                                                                                           |
| Files and ingestion              | Artifact/upload lifecycle, storage cleanup and reference rechecks, import/read paths, analyze/link claim and publication fencing, review/acceptance; OneNote read/prepare/cache/jobs and native process/extraction bounds; other office-format and vendored reader branches were sampled                      |
| AI, wiki and jobs                | Assistant/task/wiki runners, worker registration and queue wrapper, assistant leases/events/proposals/recovery, tool scope/paging/write authorization, task scheduling/context/publication; wiki admission/preparation/session/leases/tick, classify preview/accept/apply/reaping, and revert guards/recovery |
| Knowledge and dashboard          | Generation/index/enrichment lifecycle, entity resolution/publication and description invalidation, search/graph reads, activity/pins/overview/report read models                                                                                                                                              |
| Exams                            | Definitions, attempt snapshots, timed saves/submission, grades/release, proposals and tool adapters; taking/review/edit forms and autosave/timer state                                                                                                                                                        |
| Web UI                           | Shell/navigation/session/query-cache handling, unsaved-change guards, document/Python/table editing and save/conflict state, task/connection forms, scope selection, file upload, import review, wiki input and shared explorer operations; representative account/admin/project screens                      |
| Database and operations          | Prisma client/pool/session settings, schema constraints relevant to reviewed services, migration handoff barrier, configuration/public URL boundaries, Docker/Compose runtime definitions, upgrade/backup scripts and script-test fixture ownership                                                           |

Remaining depth limitations include exhaustive provider/protocol permutations, all parser and vendored native-format branches, the complete route/schema/UI matrix, and a full historical migration replay. The review did not execute every concurrency interleaving or certify any area as defect-free.

## Verification and limitations

- Executed source-backed, isolated Node harnesses for document identity deletion, exam lost-response recovery, MCP recovery trust, the key-issuance/deactivation race, deleted-document asset enumeration, classification reaping, and classification candidate starvation. These used doubles and did not mutate application data.
- Reproduced the recovery pagination ancestry problem with actual Git commands in a disposable repository.
- Attempted `node --test scripts/*.test.mjs` once. It exited nonzero; output included missing `dotenv` for environment-guard tests and a missing Next.js package for the shutdown test at the time of execution. These are environment/dependency failures, not additional application findings. Dependencies were present at the final filesystem check; the broad script command was not repeated.
- Lint/typecheck, the full dependency-backed unit suite, live browser behavior, and integration suites were not validated. The local Next.js guide directory was unavailable at the initial check. Reviewers did not install dependencies.
- No full integration or end-to-end suite, database reset/migration, provider request, production deployment, or live-account action was performed.
- The report is the only intended repository addition. Existing untracked user documents were preserved. Temporary reproduction repositories, script fixtures, logs, and caches created during review were cleaned up.

## Suggested fix order

Address R1 first with a stale-projection regression. Then close credential/recovery trust gaps (R2–R3) and protect generated/entered work (R4–R5, R12–R13). Follow with task selection and uniqueness (R6–R7), embedding and history correctness (R8–R9), classification reliability (R14–R15), and resource/fixture cleanup (R10–R11). Keep each fix scoped and run its affected area tests under the repository's existing test-tier rules.
