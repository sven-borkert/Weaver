---
name: weaver-ingestion
description: >-
  Use when working on Weaver imports, upload storage, ingestion batches and drafts, parse jobs, processing status, cleanup and recovery, review flows, or external feeds.
---

# Weaver Ingestion

Phases 5A–5C implement project uploads, real document and spreadsheet parsers,
the fenced parse/analyze/link pipeline, draft review, and accept/reject. Originals
stay outside Git; PostgreSQL holds workflow state, and only acceptance creates
Git content. Phase 5D adds the external feed endpoint for API keys.

## Ownership and access

| Concern                                                   | Canonical owner                                                                                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Models and migrations                                     | `packages/db/prisma/schema.prisma` and `packages/db/prisma/migrations/20260913000*`                                                     |
| Paths, streams, blobs, tmp cleanup                        | `packages/core/src/ingestion/{paths,blobStore}.ts`                                                                                      |
| MIME checks, limits, table typing and link bounds         | `packages/core/src/ingestion/{mimeTypes,limits,draftTable,columnTypes,links}.ts`                                                        |
| Docling endpoint settings and connection probe            | `packages/core/src/services/ingestionSettings.ts`                                                                                       |
| Parser port, adapters, OCR client, parse-stage runner     | `packages/ingestion/src/` (see module table below)                                                                                      |
| Folder proposals, lexical search, acceptance/recovery     | `packages/core/src/services/{ingestionFolders,searchLexical,ingestionAccept}.ts`                                                        |
| Authorization, state transitions, cursors, lifecycle lock | `packages/core/src/services/ingestion.ts`                                                                                               |
| Admin inspection reads (MCP-only)                         | `packages/core/src/services/ingestionInspection.ts`                                                                                     |
| Stage payload and queue contract                          | `packages/core/src/jobs/{types,queue}.ts`                                                                                               |
| Storage sweep and recovery handlers (`system.reconcile`)  | `packages/core/src/jobs/ingestionHandlers.ts`, composed by `jobs/runtime.ts`                                                            |
| Browser upload                                            | `apps/web/src/app/api/ingestion/uploads/route.ts` (thin) over `apps/web/src/server/ingestion/multipartUpload.ts`                        |
| External feed (API key), JSON form, per-key limiter       | `apps/web/src/app/api/ingestion/external/route.ts`, `apps/web/src/server/ingestion/{multipartUpload,jsonSubmission,externalLimiter}.ts` |
| Public API validation and tRPC                            | `apps/web/src/server/api/{schemas,routers}/ingestion.ts`                                                                                |
| Parse, analyze, link, and publication runners             | `packages/ingestion/src/{parseStage,analyzeStage,linkStage,publish}.ts`                                                                 |
| Imports list and per-file review UI                       | `apps/web/src/app/(workspace)/projects/[projectId]/imports/[fileId]/`                                                                   |

`packages/core/src/services/ingestion.ts` is the only authorization path for
the user-facing surface. Every upload, list, detail, draft edit, retry, and delete operation
requires project Editor or higher. Keep global Admin subject to membership;
nonmembers stay `NOT_FOUND`, while a visible lower project role gets
`FORBIDDEN`. The worker has no user actor: its identifier-only payload is
validated against a live file's canonical project and digest before a claim.

## Storage invariants

- Store originals under
  `${WEAVER_DATA_DIR}/files/<projectId>/<digest[0:2]>/<sha256>` and incomplete
  uploads under `${WEAVER_DATA_DIR}/files/<projectId>/tmp/<uploadId>`. UUID and
  lowercase SHA-256 validation makes every path canonical.
- Content addressing and deduplication are per project. Never share a physical
  blob across projects, even when their digests match.
- Stream into a create-only tmp file, hash while writing, then promote with a
  create-if-absent hard link. A blob becomes live only with its database row.
- Open upload sinks heartbeat their tmp file every ten seconds, including completed
  files waiting for later parts. Promotion failures and abort stop the heartbeat in `finally`; heartbeats last until promotion or abort. A crashed
  process leaves files to expire normally under the configured TTL.
- Registration/finalization, batch deletion, and orphan cleanup all use
  `withProjectIngestionLifecycleLock`. Deletion commits removal of the batch
  rows first, then takes a separate lifecycle-locked transaction to recheck
  `(projectId, contentDigest)` references before unlinking. Never unlink before
  the row deletion commits: a rollback could otherwise resurrect a reference
  whose blob is gone. Shared-digest blobs remain while any file in that project
  refers to them.
- Blob references, the orphan sweep, and the project quota cover
  `IngestionFile` **and** `Artifact` (the project Files store, `weaver-artifacts`)
  through the shared helpers in
  `packages/core/src/ingestion/blobReferences.ts`: a digest uploaded as both
  an import and a Files artifact is retained and billed against the quota
  once. `parseMultipartUpload` (`apps/web/src/server/ingestion/multipartUpload.ts`)
  exposes `extraField` and `resolveContentType` hooks so a caller can accept
  extra text fields and run its own filename/content-type validation instead
  of the Imports MIME-allowlist path; the artifacts upload route is the other
  consumer of this shared streaming parser.
- `system.reconcile` scans storage for every live project. Under the lifecycle
  lock it rechecks that the project is live, that a blob is still unreferenced,
  and that its mtime is older than the cutoff before unlinking. Blob checks use
  batches of 25 with one reference query per locked batch; lifecycle transactions
  explicitly allow 30 seconds. It also removes
  old regular files from `tmp/`; it does not follow symlinks or recursively
  remove unexpected entries. Storage directory discovery also covers hard-deleted projects; soft-deleted
  project blobs are reclaimable after seven days. Recheck deletion state under
  the lifecycle lock and retain the ordinary blob/tmp age cutoff.
- `WEAVER_INGESTION_TMP_TTL_MINUTES` controls storage cleanup, defaults to 60,
  and accepts 1 through 10,080. Database recovery instead waits for the longest
  ingestion queue lease (currently 60 minutes), derived from the stage job types;
  changing cleanup TTL must never revoke an active parser. Both run
  on the next `system.reconcile` cron, every 15 minutes by default. Database
  recovery is capped at 100 ordered rows per delivery; the storage scan covers
  all live projects. Sweep failures are collected per project and recovery
  publication failures per file so remaining candidates still run; storage cleanup
  and database recovery are isolated by the runtime.

## Upload and public API boundaries

The upload route authenticates and enforces same origin before it reads the
multipart stream. Clients send `projectId` first, optional `label` second, then
files; the route requires `projectId` before every file part so Editor
authorization finishes before disk writes. A request accepts at most 20 `file`
parts and two fields, 22 parts total, 64-byte field names, 4 KiB field values,
and at most
`20 * maxFileBytes + 64 KiB` bytes. `WEAVER_INGESTION_MAX_FILE_BYTES` defaults to 50 MiB. Keep the
streaming parser and exact-limit handling; do not replace it with
`Request.formData()`. The first parser/auth/metadata failure destroys the incoming
stream immediately; label and file-name validation happens before staging bytes.
Uploads reserve their declared request size before staging; chunked bodies grow a
database-backed reservation before each write. At most three live reservations
per user span Files/Imports/external feeds. Project retained bytes plus staging
reservations must fit the quota. Artifact admission grants no replacement credit before the real manifest is known;
all retained originals and concurrent reservations count until publication. Reservations heartbeat and expire after a crashed
process, and release only after publication or cleanup.
Browser and external submissions enforce `WEAVER_INGESTION_PROJECT_QUOTA_BYTES`
(5 GiB default) at finalization under the lifecycle lock, counting distinct
retained digests once. Each staged write checks
`WEAVER_INGESTION_MIN_FREE_BYTES` (1 GiB default); capacity failures return 507.
The browser normalizes Windows Excel-typed CSV to `text/csv`, shows server-authored
400/413/415 details, reports upload progress, and exposes cancellation.

The external feed (`POST /api/ingestion/external`) authenticates a personal API
key only, requires `ingest:external` plus Editor membership
(`authorizeIngestionUpload(…, "external")`), checks the per-key sliding window,
and then accepts exactly one file as multipart (same streaming parser,
`maxFiles: 1`) or as JSON with base64 content bounded by the smaller of
`MAX_EXTERNAL_JSON_FILE_BYTES` and the file cap. It never reads cookies, needs
no same-origin check, creates `origin = external` batches, and shares the
upload route's `201`/`503`-with-identity contract. Sessions and OAuth tokens
cannot use it.

Allowed formats are DOC/DOCX, XLS/XLSX, PDF, PNG, JPEG, TIFF, WebP, text,
Markdown, and CSV. The declared MIME type must match recognizable magic bytes;
text-like uploads must not carry recognizable binary magic. The route promotes
all files and creates their rows in one service transaction, then publishes
jobs. A normal response is `201 { batchId, files }`. If publication fails after
commit, the response is `503` with the durable `batchId` and files; clients
must refresh that batch and must not blindly re-upload it. Scheduled recovery
re-publishes it after the recovery cooldown. A manual retry publication failure is a
tRPC `INTERNAL_SERVER_ERROR` with `retry was stored but job publication
failed`; its durable file remains queued in the failed stage for the same
reconciliation path.

Public draft edits accept a folder path of at most 500 characters, at most 20
unique trimmed tags of 1 to 60 characters, up to 100 table columns, and up to
10 link selections. Column changes validate every stored cell; link changes
only toggle proposals already stored by linking. The service locks the
`IngestionFile` row and reloads the live project, ready state, and current draft
inside one transaction so acceptance and editing serialize. Batch listing uses
a bounded, opaque cursor tied to the project plus the `(createdAt, id)` sort
boundary; clients must never construct or reuse it across projects.

## Wiki origin

`IngestionOrigin.wiki` batches belong to the wiki (`weaver-wiki`). `createWikiIngestionFile`, `resetWikiIngestionFile` and
`retireWikiIngestionFile` are the only writers. `completeParse` sets `ready` for this origin and the parse runner publishes no
analyze job (`ClaimedFile.origin`); the wiki tick, not a worker, accepts through the source writer. `listBatches`, `loadBatch` and
`loadIngestionFile` hide the origin, so every Imports action is `NOT_FOUND`, and the import work feed filters it. Stage recovery works as usual.

## Reviewed acceptance

A reviewer may only save or accept the draft version they saw.
`IngestionDraft.revision` is bumped by every `updateDraft`; `FileDetail.draft`
exposes it, the router requires `expectedRevision` on `updateDraft` and
`accept`, and both compare it under the file row lock (`assertDraftRevision`,
`CONFLICT` on mismatch, before any Git commit). `acceptDraft` checks it only on
the first `ready → accepting` claim, so recovery of an accepting/accepted file
stays idempotent. The UI's `acceptReviewedDraft` accepts the revision its own
save returned, or the one on screen when nothing needed saving, and reloads
the draft on `CONFLICT`. Pipeline stages write the draft before `ready` and do
not bump the revision.

`ingestionAccept.ts` is the only ingestion module that touches Git. It reuses
`loadIngestionFile` for Editor authorization, claims `ready → accepting` under
the file row lock, and reloads the draft after that claim. `withProjectRepo`
owns the Git critical section; `contentOperations` supplies operation validation,
create recovery, and the normal attributed write/indexing tail. The operation id
is `ingestion:<fileId>`. An accepted retry returns the stored resource and SHA.
The per-file review route exposes ready drafts and interrupted acceptance.
Document acceptance materializes current nearest-folder/root reviewer defaults
inside the existing Git writer lock through `writeDocumentInRepo`; draft
previews do not freeze reviewer metadata or the project review interval.
Document link choices persist into the appended Related section. If it exceeds
`MAX_MARKDOWN_CHARS`, report actionable deselection feedback without changing the
stored Markdown or keep choices. Only rendered review fields receive inline
errors; other fields and unknown errors need a visible toast. Table links
are navigable, read-only suggestions because tables have no matching field.

Every failure path, including validation on an accepting retry, must prove no
matching operation commit exists before releasing to ready. Git's operation filter
matches message text, so release scans up to ten candidates plus one overflow
sentinel and checks parsed trailers. Overflow or unreadable history retains
accepting; an unrelated matching summary must never hide a real commit.
A committed failure stays accepting for retry. Finalization requires one conditional accepting update
inside the same transaction as both acknowledgement fields. Batch deletion locks
its file rows in id order under the lifecycle lock and refuses accepting
files and claimed parse/analyze/link stages; never introduce a Git dependency into `ingestion.ts` for deletion.
Rejection locks the same file row, allows ready only, and preserves the original
and draft. Accepting rejection is CONFLICT. Table suggestions are reference-only;
only document acceptance writes Related links, so table diagnostic keptLinks is 0.

## Parser adapters (Phase 5B)

`draftTableIssue` sizes a draft with `serializedRowBytes`
(`packages/core/src/tables/jsonl.ts`) over the values as they would be stored
for the current column types (empty typed cells omitted, empty text cells
kept, failed parses counted as text) and compares the total to
`MAX_DATA_FILE_BYTES`, so a Ready table draft always fits the Git table write
cap. `tableFromRows` widens a CSV table to the widest data row's last
non-blank cell and names the added columns `Column N`, matching XLSX;
`parseCsvTable` reports the affected rows through one aggregated
`headerOverflowWarning` note (header = row 1, counted over parsed rows).

`@weaver/ingestion` implements the `DocumentParser` port
(`parser.ts`: `supports`/`parse`, `ParsedDocument { markdown, tables, assets,
pageCount?, ocrPages?, warnings }`, `ParseFailure { failureKind, message }`).
`selectParser.ts` prefers the Docling adapter for the PDF/image types it
supports whenever `services/ingestionSettings.ts`'s docling-serve base URL is
configured, falling back to the native adapter only when Docling is
unreachable (`DoclingUnreachableError`) — any other Docling failure (bad
response, unsupported document, oversized output) is terminal, not a
fallback trigger. The selected adapter's id/version are recorded
(`recordParseAttemptDetails`) before parsing starts.

| Module                  | Responsibility                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `./parser`              | `DocumentParser` port, `ParsedDocument`/`ParseFailure`/`ParseOutcome` types                                          |
| `./native`              | Native adapter: Word (mammoth), Excel/CSV, text PDF + image-only pages (pdfjs-dist), images                          |
| `./docling`             | Docling adapter over docling-serve's `/v1/convert/file`                                                              |
| `./ocr`                 | OCR client: resolves the `ingestion` route, enforces the `vision` capability, transcribes                            |
| `./selectParser`        | Adapter selection order and unreachable-Docling fallback                                                             |
| `./parseStage`          | `createIngestionParseRunner`: claim → parse → draft → complete/fail, analysis publication, diagnostics               |
| `./analyzeStage`        | `createIngestionAnalyzeRunner`: bounded prompt → validated proposal → link publication; missing/unusable AI degrades |
| `./linkStage`           | `createIngestionLinkRunner`: bounded same-project document search → scored proposals → ready/fail                    |
| `./publish`             | `publishStage`: publish the next stage after a committed transition; reconciliation repairs failures                 |
| `./title`, `./markdown` | Draft title derivation and Markdown table escaping shared with the native adapter                                    |
| `./fixtures`            | Generated DOCX/PDF/PNG/XLSX byte fixtures for tests (no checked-in binary fixtures)                                  |

The parse runner wraps native parsing with `native/isolated.ts`: a child process
runs with a 256 MiB heap, while an independent parent watchdog
(`monitorProcessMemory` from `@weaver/core/process/memoryMonitor`, shared with
the artifact reader child) polls RSS every 250 ms and kills the child above
768 MiB. Deadlines are one minute for non-OCR
formats and 31 minutes for PDF/images; cancellation kills and waits for child
exit. OCR remains in the parent through bounded IPC, preserving injected test
providers. ZIP central-directory validation rejects encrypted/ZIP64 archives,
more than 10,000 entries, and more than 128 MiB aggregate expanded content before
DOCX/XLSX inflation. `packages/ingestion/src/native/archive.ts`'s `archiveIssue`
is now a thin adapter over `archiveProblem` from `@weaver/artifact-readers/archive`
(slice 2 of the project artifact store, see `weaver-artifacts`'s "Readers
package" section): it maps `not_archive` back to the original
`{ failureKind: "parser", message: "the archive could not be read" }` and every
other non-null `ArchiveProblem` to `{ failureKind: "validation", message:
"archive exceeds parser limits or has invalid metadata" }`, so this file's
observable behavior is unchanged even though the detailed ZIP-parsing logic
now lives in the shared package. Docling bodies stream through
`readBoundedResponse`; folder suggestions deduplicate and limit their rows in
SQL.

Spreadsheets (Excel/CSV) become **table** drafts; everything else (Word, PDF,
images) becomes a **document** draft. A table draft is rejected by
`draftTableIssue` (`packages/core/src/ingestion/draftTable.ts`) before it can
be persisted: at least one column, bounded columns/rows/cell length/total
bytes, trimmed unique column names; an empty spreadsheet is a validation
failure, not an empty draft. Draft columns are typed as `text`, `number`,
`boolean`, or `date`; `columnTypes.ts` infers types across every non-empty
stored cell in deterministic precedence order and validates retyped values.
Numeric conversion requires a lossless decimal round trip and an exact integer
value outside the safe-integer range. Lossy values remain text during inference
and fail explicit numeric conversion. Header normalization checks every emitted
name for collisions and reserves suffix space within the 100-character limit.
Empty typed cells become null at conversion, while text preserves its raw
value.

Scanned PDF pages and standalone images go through the OCR client over the
current `ingestion` LLM route. No route assigned, or a routed model without
the `vision` capability, fails the file `blocked_configuration` with a
message pointing back to Administration › AI; a manual retry moves it back to
`pending` once a route is fixed. `WEAVER_INGESTION_MAX_OCR_PAGES` (default
50, range 0–500) caps vision calls per file: `0` disables OCR entirely
(images fail, scanned PDF pages are skipped with a warning); pages beyond a
nonzero budget are skipped with a warning on the otherwise-successful draft —
the budget never fails an attempt on its own. A `MAX_OCR_WALL_CLOCK_MS`
deadline and a page that cannot be rasterized degrade the same way: warn on a
completed draft, never throw. The `ingestion.parse` lease
(`INGESTION_PARSE_EXPIRE_IN_SECONDS`) is longer than the general knowledge job
expiry and must stay above that deadline. Rendered PDF pages honour the same
`MAX_OCR_IMAGE_EDGE` cap as standalone images, and `renderPdfPage` takes the
open `PDFDocumentProxy` — never the bytes, which re-parses the whole file.

OCR and analysis require a complete (`stop`) model finish before accepting output.
OCR rejects partial transcripts but accepts completed blank pages; whole-file
validation still rejects an empty import. Optional analysis keeps parsed metadata with
a warning when output is incomplete or invalid. `recordAiUsageSafely` runs outside
provider failure classification and emits `ai.usage.failed` without changing the
successful result. Validation failures retain actual token usage. OCR page outcomes
and degraded analysis are visible in Diagnostics with file/job correlation.

## Stages, claims, and redelivery

All three stage jobs carry the same exact durable payload:

```ts
{
  fileId: string;
  projectId: string;
  contentDigest: string;
  baseAttemptCount: number;
}
```

The pipeline moves `pending -> parsing -> extracting -> linking -> ready`, with
each stage claim incrementing one cumulative `attemptCount`.
`extracting`/`linking` with a null matching `*StartedAt` is queued; a non-null
value is active. `stageClaimJobId` and `stageClaimRetryCount` identify the active
stage. `failedStageOf` derives manual retry from start or end timestamps so
queued-stage exhaustion retries correctly. `MAX_INGESTION_ATTEMPTS` is cumulative.
`updateDraft` applies only to a `ready` file.

Claiming is a conditional database transition. A pending claim requires the
payload's exact `baseAttemptCount`; it stores `stageClaimJobId`,
`stageClaimRetryCount`, parser identity, and start time, and increments the
cumulative `attemptCount` before stage I/O. Completion and failure match both
the active status and that attempt count; analysis/linking writes also require
their active start timestamp, so recovery reservation revokes the old worker
before a replacement claims. Analysis
stores bounded link queries and validated inferred table column types; linking
stores validated link proposals and is the only AI stage that transitions a
draft to `ready`. Linking uses at most eight lexical queries and ten candidates
per query. It passes each original title, analysis phrase, or heading into
scoring so transformed multiword `or` queries grant confidence 1 only to an
actual title match.

Analysis without an `ingestion` route degrades to the parsed title and a warning;
an unusable response does the same, while a thrown model setup or call fails the
stage as `provider`. Linking is keyword-only, same-project, and document-only.
Proposal anchors share `MAX_DOCUMENT_SECTION_ANCHOR_CHARACTERS` (180 Unicode
code points) with the canonical allocator; never truncate them into another address.
Tags remain deferred. `ingestionAccept.ts` is the only Git write and reuses
`applyOperationInRepo` with operation id `ingestion:<fileId>`; document acceptance
can append Related links, while table proposals remain read-only references.

Duplicate jobs, an old manual-retry job, and a repeated delivery with the same
or lower retry count get no claim and acknowledge as no-ops. A strictly newer
pg-boss retry delivery of the same `stageClaimJobId` may reclaim the active
stage after a crash, increments `attemptCount` again, and fences the former
worker.
This distinction is required; do not describe every redelivery as a no-op.

`system.reconcile` selects stale queued or claimed parse, analysis, and linking
rows. It snapshots all claim/attempt fields, then conditionally resets only the
unchanged active stage and publishes that stage's payload with the current
attempt count. Ingestion stages use short-policy queues with singleton identities including
file, digest, stage, and base attempt, so backlog recovery cannot accumulate
duplicate queued deliveries. `system.reconcile` uses pg-boss `retryLimit: 0`.
Reservation updates `updatedAt`, which supplies the cooldown
after a failed publication. It never discards completed earlier-stage state or
the original. Recovery is finite: a snapshot whose cumulative `attemptCount`
has reached `MAX_INGESTION_ATTEMPTS` is failed `internal` under the same
snapshot fence instead of being republished. Exhausted queued AI stages record
their end timestamp so a later manual retry still identifies the right stage.

See [Parser adapters](#parser-adapters-phase-5b) above for the real Word,
Excel/CSV, PDF, and image parsers that replaced the Phase 5A passthrough
parser. Pipes and backslashes are still escaped for Markdown tables; decoded
NUL characters are still rejected before draft persistence. Parser support and
stored byte length are checked before reading a blob, and a bounded
file-handle stat protects reads from oversized originals. Invalid parser
results become terminal internal failures before any ready transition.
Legacy `.doc`/`.xls` and `image/tiff` without a configured Docling endpoint
fail with a message naming the fix. No handler may import Git storage or
create a commit.

## Retention versus retry

`pruneProcessingHistory` prunes ingestion batches in three statements inside
its transaction — select candidates, `FOR UPDATE` their files ordered by id,
then `DELETE` with the eligibility predicate repeated. Under READ COMMITTED
each statement sees a fresh snapshot, so a retry that re-queued a failed file
keeps its batch, and a retry arriving later finds the file gone and gets its
normal `PRECONDITION_FAILED`. Do not fold this back into one statement: a
recheck inside the selecting statement shares its snapshot, and the batch
delete cascades to files and drafts without rechecking. Lock order is files
then batch, the same as `deleteBatch`.

## Adding a future stage

1. Add the identifier-only payload to `jobs/types.ts` and publish only after
   the durable prior transition commits. Keep source bytes, parsed text,
   credentials, and provider output out of the queue.
2. Use `claimAiStage` as the claim/complete/fail template. Persist the
   claim identity before external I/O, use an attempt fence for terminal
   writes, and preserve project/digest identity checks.
3. Register the handler through the existing agent-worker runtime, propagate
   `JobExecution.signal`, emit catalogued diagnostic events after committed
   transitions, and add bounded reconciliation for any publication/crash gap.
4. Expose user mutations only through the Editor-authorized service and zod
   public schema. Extend the ingestion integration spec through real services;
   use `FakeJobQueue.run(name, payload, execution)` for deterministic handler
   delivery tests.

## Verification and remaining slices

Integration tests use `.env.test`, database `weaver_test`, and `./data-test`.
Run the ingestion area set with `pnpm test:integration:ingestion`; do not invoke
Vitest directly or bypass `scripts/require-env.mjs`. `pnpm test` covers the
colocated storage, MIME, parser, queue, runtime, and UI helpers, plus
`packages/ingestion`'s own colocated adapter/OCR/fixture tests. Follow
`weaver-testing` for the tier cadence.

`apps/web/tests/integration/ingestion.spec.ts` drives all three stage runners
against `FakeJobQueue`, uses `advanceToReady` for review fixtures, and reads
accepted commits with `withProjectRepo(...).logForPath(".", { operationId })`.
Its describes include `ingestion stage transitions`, `ingestion.analyze`,
`ingestion.link`, and `ingestion accept and reject`. It builds upload bytes with
the generated fixtures in
`@weaver/ingestion/fixtures` (`docxFixture`, `pdfFixture`, `pngFixture`,
`xlsxFixture` — no checked-in binaries), and supplies OCR responses with
`ai/test`'s `MockLanguageModelV4` through `modelFactory`; Docling coverage
injects `fetchImpl` instead of reaching a real docling-serve endpoint. The
Tier 3 `apps/web/tests/e2e/imports.spec.ts` covers upload, review, and acceptance
without an ingestion route; its execution requires user approval.

Phase 5B (real Word/Excel/PDF/image parsers, Docling adapter, OCR, and
worker-role/package boundaries) and Phase 5C (analysis/linking, review, and
accept/reject) are implemented. Phase 5D (external feed) is implemented. Phase
6 adds global job visibility.

## Background-work read model

Phase 6B reads IngestionFile through services/backgroundWork/importSource.ts. Personal work uses the batch creator; shared project work requires Maintainer. Successful pipeline revision identity uses stage end timestamps (stable creation fallback for legacy rows) plus attemptCount and remains unchanged across ready/accepting/accepted/rejected. Draft edits and review decisions must not create a fresh pipeline notification. Missing recorded completion times remain null. See weaver-jobs.

## OneNote file reader worker

The ingestion worker also owns `artifact.notebook.prepare`, which prepares
read-only Files snapshots and creates no ingestion drafts or Git content.
`packages/ingestion/src/notebook/runner.ts` launches the native Rust reader; core owns durable state
and snapshot validation. Follow `weaver-artifacts` for its Viewer access,
revision/claim fencing, snapshot schema and limits. It is a separate export so
web/MCP never import the ingestion package or launch the native parser.

Image OCR reads PNG/JPEG/WebP dimensions before native decode and refuses unknown
headers or more than 50 million pixels; animated WebP is rejected. HTTP core errors
retain 409/412/500 semantics, with 413 for payload/read limits.

## Review hardening invariants

Retention treats blocked_configuration as terminal in both candidate selection and the locked fresh-snapshot delete recheck. Shared ZIP validation bounds actual decompression before DOCX/XLSX parsing.
