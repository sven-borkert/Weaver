---
name: weaver-artifacts
description: Use when changing Weaver artifacts/Files, blob storage and upload/download routes, artifact tools, pure Word/Excel/PDF/JSON/text/Markdown/CSV/YAML readers, or OneNote cache and background preparation.
---

An artifact referenced by a live `WikiInputItem` (any status except `failed` and `removed`) refuses replace and delete with
`CONFLICT SOURCE_PROTECTED`, checked under the lifecycle lock in `finalizeArtifactUpload` and `deleteArtifact`. Rename stays allowed.

# Weaver Artifacts (Files)

Slice 1 of the project artifact store: every project has a Files page for
original files of any type — a sibling surface to Imports, sharing its
project-local, content-addressed blob storage instead of feeding the
knowledge pipeline. Slice 2 adds `@weaver/artifact-readers`, a pure leaf
package of file-reading functions for Word/Excel/PDF/JSON artifacts — see
"Readers package" below. Slice 3 adds ten read-only tools
(`search_artifacts`, `get_artifact_overview`, `search_artifact_text`,
`query_json_artifact`, `read_pdf_pages`, `read_word_chapter`,
`read_word_blocks`, `find_word_tables`, `read_word_table`,
`read_excel_sheet`) that expose these
readers to the assistant and MCP clients — see "Tools (slice 3)" below.

## Ownership

| Concern                                                                        | Canonical owner                                                                                                |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Model and migration                                                            | `packages/db/prisma/schema.prisma` (`Artifact`), `packages/db/prisma/migrations/20260922001200_artifact_store` |
| Filename validation and per-project identity                                   | `packages/core/src/artifacts/filenames.ts`                                                                     |
| Content type from extension, contradiction-only byte sniffing                  | `packages/core/src/artifacts/contentTypes.ts`                                                                  |
| Gateway service: list/get, upload authorize + finalize, rename, delete, stream | `packages/core/src/services/artifacts.ts`                                                                      |
| Shared "is this blob still referenced" / quota accounting                      | `packages/core/src/ingestion/blobReferences.ts` (covers `IngestionFile` **and** `Artifact`)                    |
| Upload route                                                                   | `apps/web/src/app/api/projects/[projectId]/artifacts/route.ts`                                                 |
| Download route                                                                 | `apps/web/src/app/api/projects/[projectId]/artifacts/[artifactId]/download/route.ts`                           |
| Streaming multipart parser (shared with Imports)                               | `apps/web/src/server/ingestion/multipartUpload.ts`                                                             |
| tRPC router and input schemas                                                  | `apps/web/src/server/api/routers/artifact.ts`, `apps/web/src/server/api/schemas/artifact.ts`                   |
| Files page: list, search, sort, page, upload, rename, delete                   | `apps/web/src/app/(workspace)/projects/[projectId]/artifacts/`                                                 |
| Nav entry                                                                      | `apps/web/src/app/(workspace)/_components/ProjectSections.tsx` ("Files" → `<project>/artifacts`)               |

`packages/core/src/services/artifacts.ts` is the only module that reads or
writes the `Artifact` table on the user-facing surface; the router and routes
are thin adapters over it, matching `services/ingestion.ts`'s role for
Imports.

## Storage invariants

- Content appearance icons are separate Git assets at
  `.weaver-icons/<sha256>.<png|jpg|webp>`, owned by
  `services/{contentAppearance,appearanceAssets}.ts`. They are not `Artifact`
  rows or Files/Imports blobs and do not use the blob-store quota or lifecycle
  lock. See **weaver-documents** for their authorized routes and portability.
- Artifact blobs live in the same project-local, SHA-256-addressed store as
  Imports (`${WEAVER_DATA_DIR}/files/<projectId>/<digest[0:2]>/<sha256>`,
  `packages/core/src/ingestion/blobStore.ts`); uploads promote a staged tmp
  file with a create-if-absent hard link, same as Imports.
- Finalize (upload), rename, and delete all take
  `withProjectIngestionLifecycleLock` (`packages/core/src/services/ingestion.ts`),
  the same per-project advisory-lock transaction Imports uses. The lock hashes
  the **lower-cased** project id, so a mixed-case UUID from a URL (accepted by
  `UUID_RE`/`z.uuid()`, and equal in Postgres) serializes against the canonical
  key. Never introduce a second locking path for `Artifact` rows.
- Deletion and replacement are two-phase: the row change (delete, or the
  `contentDigest` update on a replace) commits first inside the lock; a
  **separate** lifecycle-locked pass then rechecks `isBlobReferenced` before
  unlinking the old blob (`unlinkUnreferenced` in `services/artifacts.ts`).
  Never unlink before the row change commits — a rolled-back transaction could
  otherwise resurrect a reference whose blob is already gone.
- `packages/core/src/ingestion/blobReferences.ts` is the **only** definition
  of "this digest is still referenced" and of retained bytes for the quota.
  `referencedDigests`/`isBlobReferenced` union `IngestionFile` and `Artifact`;
  `retainedBytes` sums the max byte size per distinct digest across both
  tables (plus the incoming batch, minus excluded artifact ids on a replace).
  Any future table that stores a `contentDigest` referencing this blob store
  must be added here, or its blobs will be swept as orphans.
- The quota (`WEAVER_INGESTION_PROJECT_QUOTA_BYTES`, 5 GiB default) and the
  orphan sweep (`system.reconcile`) are shared between Imports and Files: a
  digest already held by an `IngestionFile` costs nothing extra when also
  uploaded as an Artifact, and vice versa. `finalizeArtifactUpload` throws
  `PRECONDITION_FAILED` when the projected retained total exceeds the quota;
  **the artifacts upload route maps this to HTTP 412**, the same as the
  Imports upload route — it is not 413 (413 is reserved for a single file or
  the whole request exceeding the byte cap).
- Soft-deleted project blobs are reclaimable by `system.reconcile` after seven
  days, the same rule as Imports (`weaver-ingestion`'s storage invariants) —
  the sweep scans blob paths per project, not per referencing table, so it
  applies to Artifact-only blobs exactly as it does to Imports-only blobs.
- `Artifact.byteSize` is a Postgres `INTEGER` (not `bigint`); values are
  validated as a safe, non-negative integer `<= 2_147_483_647` before being
  stored (`finalizeArtifactUpload`). This is a deliberate deviation from the
  usual `bigint`.
- `filenameKey` (`packages/core/src/artifacts/filenames.ts`) is the NFKC-
  normalized, lower-cased filename and is the per-project identity
  (`@@unique([projectId, filenameKey])`, `VarChar(255)`). `validateArtifactFilename`
  rejects an empty name, a name over 255 characters, leading/trailing
  whitespace, a name starting with `.`, control characters or path separators
  (`/`, `\`) — and runs **the same checks against the NFKC key**, so a
  fullwidth `．hidden` (U+FF0E) or `a＼b.pdf` (U+FF3C), whose key folds to
  `.hidden` / `a\b.pdf`, is rejected too, and a name whose key exceeds 255
  characters is rejected even when the raw name does not (NFKC can expand a
  character, e.g. `㍿` becomes 4), since the stored key must still fit the
  column.
- Content type is derived from the filename extension
  (`contentTypeForFilename`; unknown extensions fall back to
  `application/octet-stream`) and never trusted from the client's declared
  MIME type. Byte sniffing (`artifactContentMatches`) only ever **rejects** a
  file when its magic bytes contradict a content type Weaver can recognize
  (PDF/PNG/JPEG/WebP, or the shared ZIP container for `.docx`/`.dotx`/`.xlsx`/`.zip`)
  — every other extension passes unchecked. Renaming re-derives the content
  type and rechecks the stored magic bytes when the type changes.
- `finalizeArtifactUpload` maps a unique-index race on `(projectId,
filenameKey)` (Prisma `P2002`, e.g. two concurrent uploads of the same new
  name) to a `CONFLICT` `CoreError`, the same shape as an explicit
  duplicate-without-`replace` conflict. A replace whose target row vanished
  between the conflict check and the update (Prisma `P2025`) is the same
  `CONFLICT` shape ("the file being replaced was deleted; upload it again"),
  never a 500.
- Downloads stream. `openArtifactStream` (`services/artifacts.ts`) opens the
  blob with `O_RDONLY | O_NOFOLLOW` (`openBlobStream` in
  `ingestion/blobStore.ts`, 1 MiB chunks), refuses a non-regular file, a size
  over `maxBytes` (`BAD_REQUEST`) or a size that differs from
  `Artifact.byteSize` (`NOT_FOUND` "file content is no longer stored") before
  the first byte, and pipes the rest through an incremental SHA-256 transform
  that **errors the stream at its end** when the byte count or digest
  disagrees with `contentDigest`. Nothing buffers the whole file in the web
  heap; `readBlob` remains for the reader child and Imports' parse stage.

## Access

- List, get, and download require project **Viewer** or higher
  (`projectIdFor(..., "Viewer")` in `services/artifacts.ts`).
- Upload (`authorizeArtifactUpload`), rename, and delete require project
  **Editor** or higher, checked before any request byte reaches disk for
  uploads (same pattern as `authorizeIngestionUpload`).
- The download route hides access failures behind `"not found"`
  and maps a `FORBIDDEN` (403) status to `404` so a
  nonmember, a Viewer-denied case, and a genuinely missing/deleted artifact
  are indistinguishable from outside the route. A non-UUID project or artifact
  id is also `404` (never `400`); `401` (unauthenticated) keeps its own code
  with its own message. Operational failures preserve 500/409/412, and an
  oversized download is 413.
- The download route answers `If-None-Match` against the stored
  `contentDigest` (`getArtifact`, metadata only) **before** touching disk, so
  a 304 costs no read; only a 200 then takes one of the caller's
  `MAX_DOWNLOADS_PER_USER` (4) in-flight slots — a 5th concurrent download
  is `429` with `retry-after: 15`, the same shape as the assistant SSE cap.
  The slot is released when the body is drained, errors, is cancelled, or the
  request aborts. The 200 carries `content-length` from the blob's stat size
  and a streaming body; there is no per-minute rate limit.

## Upload contract

- One `POST` to `/api/projects/<projectId>/artifacts`, authenticated,
  same-origin, streamed through the shared parser in
  `apps/web/src/server/ingestion/multipartUpload.ts`. `projectId` appears
  exactly once and must precede every `file` part (authorization runs before
  any file byte reaches disk); zero or more `replace` text fields may appear
  anywhere, since they are only read after the whole body is parsed (the
  browser client sends `projectId`, then `replace`, then the one to
  `MAX_INGESTION_UPLOAD_FILES` (20) `file` parts). The route supplies
  `multipartUpload`'s `extraField` hook
  to accept repeated `replace` fields (capped by `maxExtraFields`) and its
  `resolveContentType` hook to run `validateArtifactFilename` +
  `contentTypeForFilename` + `artifactContentMatches` per file, in place of
  the Imports route's MIME-allowlist hook.
- A `replace` field's value is matched against an uploaded file's name by the
  case-insensitive NFKC filename key (`artifactFilenameKey`), not by exact
  string equality — matching or differently-cased duplicates of an existing
  name still count as a replace.
- The batch is all-or-nothing: `finalizeArtifactUpload` checks every file's
  existing-name conflict up front (against the whole batch, before writing
  anything) and performs every create/update inside one
  `withProjectIngestionLifecycleLock` transaction, so a batch either fully
  commits or fully fails — never a partial set of files.
- A name collision without a matching `replace` field is `409` with body
  `{ "error": "<message>", "conflicts": ["<filename>", ...] }`; the browser
  (`uploadArtifacts.ts`) re-offers those names to the user to confirm as
  replacements and resubmits with them in `replace`. The quota error
  (`PRECONDITION_FAILED`) is `412`, not `413` (see Storage invariants).

## Verification

- `pnpm test:integration:artifacts` runs the area's one integration spec
  (`apps/web/tests/integration/artifacts.spec.ts`) through
  `scripts/require-env.mjs` against `.env.test` / `weaver_test` / `./data-test`.
  Never invoke Vitest directly against it.
- `pnpm check` (lint + typecheck) and `pnpm test` cover the colocated unit
  tests: `artifactType.test.ts`, `artifacts-state.test.ts`,
  `artifactBatch.test.ts`, `uploadArtifacts.test.ts`,
  `ArtifactsTable.test.tsx`, `ArtifactUpload.test.tsx`,
  `ArtifactsScreen.test.tsx` under the Files page's `_components/` directory,
  plus `packages/core/src/ingestion/blobStore.test.ts` (`openBlobStream`) and
  `packages/core/src/artifacts/filenames.test.ts`. `ArtifactUpload.test.tsx`
  and `ArtifactsScreen.test.tsx` mount with `react-test-renderer` for the
  busy/typing cases (mock `~/components/ui/dialog`, honouring `open`, and keep
  the list empty — Radix Portal/Menu need a DOM `document` the node
  environment lacks).
- The upload drop zone keeps `aria-busy` and adds a visually hidden
  `role="status"` span that changes only at 25 % milestones
  (`Uploading… 0/25/50/75%`, then "Files sent. Finishing upload…") so the live
  region is not chatty; the visible percentage text updates every step.
- The Files search input has `maxLength={200}` and the debounced term is
  sliced to 200, matching `listArtifactsInput.search` (a longer term used to
  fail Zod and blank the list).
- The Files page has not been exercised in a real browser or by an e2e spec
  as of this slice — `apps/web/tests/e2e/` has no Files/artifacts spec. Treat
  any UI-level claim beyond the colocated component tests as unverified.
- `pnpm test:integration:artifacts` now runs two specs:
  `artifacts.spec.ts` (the Files surface, above) and `artifactTools.spec.ts`
  (the ten read tools, below).

## Tools (slice 3)

Ten read-only file tools in
`packages/assistant-tools/src/tools/{artifacts,artifactsWord,artifactsShared}.ts`,
all `kind: "read"` / `capability: "content:read"`, registered in
`ASSISTANT_TOOLS` (`packages/assistant-tools/src/registry.ts`) directly after
`aggregate_table` and therefore part of `MCP_TOOLS` too: `search_artifacts`,
`get_artifact_overview`, `search_artifact_text`, `query_json_artifact`,
`read_pdf_pages`, `read_word_chapter`, `read_word_blocks`, `find_word_tables`,
`read_word_table`, `read_excel_sheet`. The assistant registry now carries 39 tools total; see
`weaver-assistant` for the full list and prompt-budget numbers.

### Text, CSV, YAML and structured tool contracts

Three additive shared read contracts live in `artifactsText.ts`, `artifactsCsv.ts`
and `artifactsStructured.ts`: `read_text_artifact`, `read_csv_artifact` and
`inspect_structured_artifact`. Raw source reads accept TXT/Markdown/YAML/CSV
(default 100 lines, maximum 500); CSV reads accept original string rows and
zero-based columns (default 50 rows, maximum 200, headers enabled by default);
structure inspection accepts JSON/YAML. Existing Word/DOTX, XLSX, PDF, JSON and
cached OneNote tools retain their contracts and extraction limitations.
Overview delegates paged Markdown headings, CSV columns and YAML root shape;
text/CSV search is case-insensitive literal search (default 25, maximum 100),
while native search keeps default 20 and rejects new paging/CSV
options. JSON query also accepts YAML; unsupported YAML remains raw-readable. JSONPath inputs
accept up to 8192 UTF-8 bytes with unchanged grammar and dotted-field projection,
so bounded structure paths remain usable. An escaped
query header that cannot fit the complete output returns a shorter-path error.

`artifactFormatOf(contentType, filename)` preserves native mappings and recognizes
validated `.txt`/`.md`/`.csv`/`.yaml`/`.yml` filename fallback only with existing
`text/*` or `application/octet-stream` metadata. This includes older YAML uploads
without replacement and never changes native MIME mappings.
Always pass the filename, including discovery's readable flag. YAML uploads and
renames now use `application/yaml`. Operation gates list allowed formats; Markdown
mode is derived by the authorized gateway, never from a child filesystem path.

Every complete output includes the envelope, escaped strings and signed cursor
within 16,000 UTF-8 bytes. The child clips `text.read` to an internal serialized
text budget using owned position helpers, preserving CRLF cuts and touched-line
counts. Tools must never runtime-import pure reader subpaths. Lists retain a
prefix and cursor at the first unsent item; oversized CSV rows expose omissions
and advance. Exact structure addresses never truncate: an address/envelope that
cannot fit returns actionable BAD_REQUEST with shorter ancestor-pointer guidance.

Markdown sectionId is mutually exclusive with explicit startLine/endLine. Reject
the combination before synthesizing a range default; section-only continuations
must not forward a synthesized startLine to the pure reader.

Text cursors carry original range start plus actual next line/character. A caller
may omit startLine or repeat the original start, never replace it with the current
page line. CSV repeated startRow must equal the actual resumed row. Query identities
bind range/section, delimiter/header/projection, pointer/depth/samples or search
query as relevant, excluding page-size limits. Replaced content fails STALE_BASE;
conflicting query/start values fail INVALID_CURSOR. All file strings remain
untrusted prompt data. Files re-parse in the child per call; no persistent cache
is added.

### Isolation

Every reader call — never in-process — goes through `runArtifactReader`
(`packages/core/src/artifacts/readerProcess.ts`), which forks a short-lived
child (`packages/core/src/artifacts/readerChild.ts`, the **only** module that
imports a reader subpath at runtime — enforced by
`scripts/package-boundaries.test.mjs`):

- `--max-old-space-size=512`, an RSS watchdog at 1 GiB
  (`packages/core/src/process/memoryMonitor.ts`, shared with Imports'
  isolated native parser), `SIGKILL` on timeout, RSS breach, abort, or once a
  result arrives.
- Timeout 60 s, 120 s for `pdf.*` operations; the deadline covers the wait
  for a slot, not just the child's own run. A deadline that expires before a
  slot is granted is reported as `busy`, not as a timeout (see "Error
  mapping").
- At most 2 children run at once per process; a 3rd–10th concurrent caller
  waits (FIFO); an 11th gets a `busy` failure → `TOO_MANY_REQUESTS`
  immediately, without waiting.
- The child reads the blob itself and verifies its SHA-256 against the
  digest it was handed, before parsing anything; a mismatch or missing blob
  is `not_found` "file content is no longer stored". Only identifiers
  (`dataDir`, `projectId`, `contentDigest`, `maxBytes`, `operation`, `input`)
  cross the IPC into the child; the parsed result is what crosses back.
- The child's serialized result is capped at 2 MiB (`MAX_READER_RESULT_BYTES`,
  measured in UTF-8 bytes on both sides); the parent trusts nothing the child
  sends (`parseChildMessage`) — a malformed message, an unrecognized failure
  code, or an oversized payload all become the fixed `unavailable` "reading
  the file failed", never a raw error or the native message. The parent's
  size check is inherently post-receive (Node has already buffered and
  structured-cloned the whole IPC message), so it only catches a buggy or
  compromised child; the honest child enforces the cap before sending.
- Readers bound their own results so the cap stays out of the way of tool
  paging: `word.chapter`, `word.blocks` and `word.table` return one window (`fromBlock` /
  `fromRow`, default 200, hard max 500) plus `blockCount`/`nextBlock` and
  `header`/`rowCount`/`columnCount`/`nextRow`; `word.outline`,
  `word.tableInventory` and `json.overview` cap their lists at 5,000
  entries (`OVERVIEW_ENTRY_CAP`) with `truncated: true`. A single JSON match
  larger than 2 MiB still trips the cap.
- A child that dies with `SIGABRT` and no exit code is classified
  `unavailable`/`memory` (V8 ends a heap-limit fatal with `abort()`), like
  the RSS watchdog kill; any other signal death stays `crashed`.
- Each tool call forks and re-parses the file; there is no cache.
  `get_artifact_overview` on a Word file forks **twice**, sequentially
  (`word.outline` then `word.tableInventory`).
- The child runs with a minimal environment (`PATH`, `NODE_ENV`, `TZ=UTC`
  only) and no stdio beyond its IPC channel.
- **Over MCP the reader's own deadlines rarely decide anything.** The MCP
  server aborts every tool call at `WEAVER_MCP_TOOL_TIMEOUT_MS`
  (`packages/config/src/server.ts`: 1,000–120,000 ms, default **30 s**;
  `executeContract` in `packages/mcp/src/tools.ts` composes it into the
  request signal), which is well inside the reader's 60 s / 120 s deadline.
  That abort travels down `ctx.signal` into `runArtifactReader` and SIGKILLs
  the child, so an MCP caller sees the tool's cancellation, not a reader
  timeout. Raise the variable (max 120 s) before blaming the reader for a
  large PDF that "always times out" over MCP; the in-app assistant has no
  such per-call cap and does reach the reader's own deadlines.

### Output shape

`{ artifact: { id, filename, contentType, byteSize, sha256, updatedAt, url },
result }` for every tool except `search_artifacts`, which has no single
artifact and returns `{ page, total, truncated, items }` directly. `url` is
the app-relative Files-page link `?file=<filename>` (`artifactUrl` in
`artifactsShared.ts`) — a tool has no base path to build an absolute link
with, so the **in-app assistant transcript** prefixes every app-relative link
it renders (`withAssistantBasePath` in
`apps/web/src/components/assistant/AssistantMarkdown.tsx`, over
`withBasePath`), while **MCP clients receive the app-relative path and must
resolve it against the deployment's base URL** themselves. The Files page
reads `?file=` to pre-fill search — with at most the 200 characters
`listArtifactsInput.search` accepts, though a filename may be 255 long — and
remounts on a new deep link. No artifact citations: `SourceLocator` has no
artifact variant.

### Error mapping

`packages/core/src/services/artifactReads.ts`'s `toCoreError`: reader
`not_found` → `NOT_FOUND`; `busy` → `TOO_MANY_REQUESTS`, which
`toolErrorFromUnknown` now forwards to the model and to MCP clients as the
`ToolError` code `TOO_MANY_REQUESTS` with the fixed message "too many file
reads are in progress; try again shortly" (it used to collapse into
`INTERNAL` "tool failed", so nothing could tell a retry from a crash);
`resource_limit` and `unavailable` with cause `timeout`/`memory` →
`BAD_REQUEST` reason `PAYLOAD_TOO_LARGE`; every other reader code → plain
`BAD_REQUEST`.

An operational failure is not a caller error: `unavailable` carries a
machine-readable `cause` (`timeout | memory | crashed | not_started`, each
with its own fixed message, plus the child's `exitCode`/`signal` where the
runner can report them), and `crashed`/`not_started` — a dead child, a
malformed or oversized IPC message, a fork that never started — map to
`INTERNAL_SERVER_ERROR` "reading the file failed on the server", which
`toolErrorFromUnknown` turns into the generic `INTERNAL` "tool failed".
`readArtifact` emits `artifact.reader.failed` (category `content`, severity
`error`) for those two with `cause`, `operation`, `artifactId`, `projectId`
and the exit status — never the filename, never content. A child that
aborted on its own heap limit (`memory` with `signal: "SIGABRT"`) is the
file's fault: it maps to `PAYLOAD_TOO_LARGE` like the watchdog kill and is
recorded under the same event at severity `warn` with the same fields. `busy` covers both
a full wait queue and a deadline that expires while the read is still
waiting for a slot (the child never ran, so the caller may retry); only a
deadline that expires while the child is running is `timeout`.

A tool called on the wrong file type
throws `wrongFormat` (`artifactsShared.ts`) — `BAD_REQUEST` naming the one
right tool from a single `FORMAT_TOOLS` table.

### Cursors

Signed, `weaver-artifact-cursor-v1:`-prefixed
(`packages/core/src/services/artifactCursors.ts`, a sibling codec to
`contentCursors.ts` with its own HMAC domain), bound to `{ tool, projectId,
artifactId, contentDigest, query }`. A digest mismatch alone (the file was
replaced) is `BAD_REQUEST`/`STALE_BASE`; any other binding mismatch, or a
malformed/tampered cursor, is `BAD_REQUEST`/`INVALID_CURSOR`.
Every tool looks the artifact up twice — `describeArtifact` (which the cursor
and binding are built from) and then `readArtifact` — so after the read it
compares the digest it actually loaded with that one
(`assertSameContent` in `artifactsShared.ts`, `readOperation`'s
`expectedDigest`) and fails the same `STALE_BASE` if the file was replaced in
between; the Word overview's two sequential reads are both checked against
the described digest.
`query_json_artifact` pages the same way since the 2026-09-21 review fixes:
its cursor binds `{ path, fields }` (limit excluded) and carries the next
offset, `nextCursor` is the continuation, `offset` is accepted only to start
a fresh read (a repeated `offset` must agree with the cursor, else
`INVALID_CURSOR`), and `nextOffset` is kept for MCP readability. A cursor
continued after the file was replaced fails `STALE_BASE` like every other
file tool; the head charges a placeholder cursor before any item.
`read_excel_sheet`'s workbook form (no `sheetName`) cannot resume by sheet
index — `readExcelWorkbook` reports no worksheet index per returned sheet
and drops sheets that yield no rows — so its cursor instead replays the
reader's own deterministic page and skips the rows already sent
(`"<sheet>:<row>_<skip>"`); the sheet form resumes with the reader's plain
row-number cursor.

### Output budgeting

Every output stays inside the shared 16,000-**byte** (UTF-8) tool-output
cap — `MAX_TOOL_OUTPUT_CHARS` is a byte cap under a historical name, see
`weaver-assistant`; every size here (`budgetAfter`, `entrySize`,
`headText`, `cellText`, the `budgetChars` limits of the assemblers) is
charged in bytes, and character cuts are re-checked against the byte budget.
Beyond the usual `newPageBudget`/`boundItems`/`fitTextChunk`, these tools
also: charge the envelope and head to the page budget before bounding any
list (`budgetAfter`); clamp every file-derived string that sits in a head
(`headText`, 500 bytes) or a cell (`cellText`, 120 bytes in
overviews, 20,000 in row reads); clamp every file-derived string inside an
overview LIST ITEM before `boundItems` sees it (`overviewText`, 200 bytes,
with a per-item `titleTruncated`/`captionTruncated`/`nameTruncated`/
`keyTruncated` flag only when it cut) — `boundItems` keeps a prefix, so one
20,000-character heading would otherwise be the whole page and every chapter
after it would vanish; bound a repeated header row to a fixed
share of one page (`boundHeadCells` — a third for `read_word_table`, a
sixth per candidate for `find_word_tables`) and report `headerTruncated`;
clamp an oversized paragraph/row/JSON item and advance past it rather than
stall the cursor (the JSON reader keeps a first match larger than its own
128 KiB clip, flagged `truncated`, precisely so the tool can clamp it as
`truncatedJson` and advance `nextOffset`); report `omittedPageTail` when a
single PDF page is longer than the reader's own 100,000-character read
window; report `omittedSheetCount` for a workbook with more sheets than the
Excel overview keeps. `read_word_chapter` and `read_word_table` ask the
reader for one window starting at the cursor (see "Isolation"), assemble
the page from that window, and continue with the reader's `nextBlock` /
`nextRow` when the page consumed the whole window — a cursor is still a
plain block or row index.

### Word outline and positions

The reader (`packages/artifact-readers/src/word/{structure,typography}.ts`)
takes chapter headings from three sources, in this order; the overview
reports which one won as `outlineSource` (`styles`, `inferred` or `none`).

An effective `w:outlineLvl=9` marks body text: the nearest paragraph or style
declaration stops inheritance and disables both `Heading N` fallback and
typography inference for that paragraph. These paragraphs still contribute
to body-font and heading-share statistics. Other paragraphs use:

1. A `Heading N` paragraph style id.
2. A paragraph's own `w:outlineLvl` (0-8, level = value + 1), or one inherited
   through the paragraph style's `basedOn` chain (custom or localized
   heading styles).
3. Only when the body has no declared heading at all, inference from
   typography (`typography.ts`, `inferHeadingLevels`).

Inference: a paragraph's size is its smallest text-run size (run `w:sz`, run
style chain, paragraph style chain, `w:docDefaults`, else 20 half-points) and
it is bold only if every text run is. The body size is the size carrying the
most characters; when two sizes carry the same number of characters the
smaller is the body size. Candidates are body-level paragraphs (no table
cells, no TOC) of 1-120 characters. A candidate at least 1 pt larger than
the body size is a heading; the distinct larger sizes, largest first, map to
levels 1-4 (smaller ones share level 4). A candidate at body size, all bold,
at most 80 characters and not ending in `.`, `,`, `;` or `:` is a heading one
level below the size-based levels. Inference is discarded (`none`, one
`document-body` chapter) when it yields fewer than 2 headings or more than
35 % of the body's text paragraphs would be headings — the share is measured
against every measured paragraph, not only the short candidates, so prose
with long paragraphs keeps its outline. A font size of 0 (`w:sz`, in a run,
a style or the document defaults) counts as unset. Chapter ids stay positional
(`chapter-NNN`); inferred chapters carry `inferred: true` and the overview
adds a hint saying the outline is a best guess. Overview chapters also carry
`blockCount` and the heading's `blockId`; the synthetic chapters
(`chapter-000`, `document-body`) have no heading, the reader returns
`blockId: null` for them and the overview leaves the key out. A tool schema
that parses reader output must mirror the reader type's nullability, or
`readerResult` turns the read into `INTERNAL` "tool failed".
`search_artifact_text` Word matches carry `chapterTitle`.

`read_word_blocks` (`artifactsWord.ts`, reader op `word.blocks`) reads body
blocks in document order from `fromBlockId` (`p-NNN` or `table-NNN`),
optionally to `toBlockId` (inclusive), with `before` (0-20) lead-in blocks,
`includeTables` and `includeInstructions`. `startBlockId` is the first block
of the range, lead-in included, and `startChapter` the chapter it lies in —
the range start, not the first block returned: the instruction filter may
drop that very block. The cursor is bound to all of those
inputs plus the file digest (`fromBlockId`, `toBlockId`, `before`,
`includeTables`, `includeInstructions`) and is a plain window index, like
`read_word_chapter`'s; both tools share `readBlockWindow` in the reader.

### Word images

`packages/artifact-readers/src/word/images.ts` (`createImageResolver`)
resolves `a:blip` (embed, then link) and `v:imagedata` through
`word/_rels/document.xml.rels` to a media part, reads it with the 16 MiB part
bound, sniffs PNG/JPEG/GIF/WebP, and hashes it. `imageId` is the SHA-256 of
the media part. Only a part named `word/media/<one segment>` gets an id
(`WORD_MEDIA_PART`, exported from `archive.ts` and shared with the copy path
below, so the reader never hands out an id the copy cannot find); a picture
stored anywhere else is reported as missing. Alt text comes from `wp:docPr`
(`descr`, else `title`) or the VML shape's `alt` and is reset per picture;
`mc:Fallback` content is skipped, so a picture stored in two formats is
reported once. The walk descends into `w:txbxContent`, so a picture in a text
box anchored in a body paragraph is reported with that paragraph. The 200
limit (`MAX_MEDIA_PARTS_PER_READ`) is on DISTINCT media parts inspected per
read, whatever the outcome (not on images returned); past it the picture is
skipped with a warning. The four warning texts are "unsupported image format
was omitted", "image data is not included in the file" (linked picture, part
missing or outside `word/media/`, or an entry that cannot be read: corrupt
stream, unsupported compression), "image is too large" (only an entry over
the 16 MiB bound) and "more images were omitted". Paragraph blocks gain
`images` and `imageWarnings`, table blocks `imageCount` (every picture
reference in the table, the same references `read()` reports as an image or
a warning), and `read_word_table` returns `images` with
`rowIndex`/`columnIndex` for its row window. The tool requests
`includeHeaderImages` only on its first page, so row-1 pictures are returned
even for header-only tables. Data-row windows and cursors stay unchanged,
all picture row indices remain 1-based, and continuations do not repeat header
pictures.

The tools turn each image into `![alt](weaver-image:<artifact id>/<imageId>)`
beside the block's text, charged to the page budget. A paragraph clamped by
the page budget drops its images and warnings but keeps `imageCount` on the
clamped entry (also on the id-only fallback, unless the count itself would
overflow the budget). A document write copies an image like a OneNote image.
That copy path cannot use the reader child (`documentImageImports.ts` is
bundled by the web app), so `packages/core/src/artifacts/wordImages.ts` runs
in process on `@weaver/artifact-readers/archive` only (central directory plus
bounded inflate, no XML):

- `readArchiveEntries(bytes, accept, maxBytes, { maxEntries, maxNameBytes },
visit)` (`archive.ts`) walks the central directory ONCE, reads each entry
  `accept` names and hands it to `visit` as `{ name, bytes, tooLarge,
inflatedBytes }`; `visit` returns false to stop. It returns false when the
  walk was stopped, more than `maxEntries` entries were accepted or the
  directory is unreadable, never decodes a name longer than `maxNameBytes`,
  and never throws. An entry whose declared size is over `maxBytes` is
  flagged without inflating. It is a visitor rather than a returned list so
  that only one entry's bytes are alive at a time and the caller's budget can
  end the walk.
- `findWordImages(docx, wanted, maxImageBytes)` (`wordImages.ts`) takes the
  hashes the write asks for and returns `{ images, complete, oversized }`.
  It keeps ONLY the wanted pictures, as copies (`Buffer.from`) — a stored
  entry is a view into the `.docx` buffer and would pin the whole file — and
  stops as soon as all of them are found. Limits: 500 media entries and
  64 MiB of inflated data (an entry that was read costs its size; one that
  hit the bound or failed while inflating costs the per-image limit; one
  rejected before inflating costs nothing). `complete: false` means a limit
  ended the scan; `oversized` counts media parts over
  `WEAVER_DOCUMENT_IMAGE_MAX_BYTES`. Which hash an over-limit part has is
  unknowable without reading it, hence the count.
- `documentImageImports.ts` collects, per artifact, the image ids the write
  references before anything is read (`imageLimits`), authorizes with
  `getArtifact` first, then reads, hashes and scans each distinct Word file
  once and lets the `.docx` buffer go; the per-call memo holds the lookup
  result, not the file. The source `.docx`/`.dotx` may be at most 64 MiB,
  since the whole file is read into memory. `checkImageReferences` (proposal
  preview) therefore does read a referenced Word file.

A Word reference that does not resolve fails `BAD_REQUEST` on `markdown`
with one of five reasons after the reference: "is in a Word file too large
to copy images from" (source over 64 MiB), "is no longer stored" (blob
missing or digest mismatch), "is not an image of this Word file" (scan
complete, nothing over the limit), "is not an image of this Word file, or
exceeds the document image size limit" (scan complete, at least one media
part over the limit) and "could not be located: this Word file has too many
or too large pictures" (scan ended by the entry or byte limit; checked before
the oversized case). `scripts/package-boundaries.test.mjs` allows `/archive`
only in `wordImages.ts` — every other reader subpath stays child-only — and
pins `archive.ts`'s own imports to `node:zlib` and `./errors` (and
`errors.ts` to none), so the in-process path can never pull a parser in.

### Open after this slice

- No test has read a file produced by a real Word, Excel or PDF writer —
  every fixture is synthetic. A manual check against real files is still
  due.
- No artifact citations.
- Images in headers, footers and footnotes are not reported.
- Heading inference has been checked against one real OneNote export only.
- `read_word_table` images follow the reader's row window, not the rows the
  page kept, so an image can repeat on the next page; images cut by
  `imagesTruncated` cannot be fetched by cursor.
- A write holds the pictures it copies in memory until the commit (at most
  100 × `WEAVER_DOCUMENT_IMAGE_MAX_BYTES`), and one Word file at a time while
  it is scanned (at most 64 MiB); nothing else of a Word file is retained.
- Word/Excel/PDF/JSON/text/Markdown/CSV/YAML reads re-parse on every call;
  OneNote uses the cache described below.
- Two silent caps stack on a dropdown list: the reader's own `maxControls`
  (100, `word.table`) and the tool's page-share budget; a table with more
  than 100 dropdown controls loses the rest with no flag.
- `.xlsb` is refused as `malformed`, not `legacy_format` (ExcelJS doesn't
  recognize it as a workbook at all).
- The RSS-kill path (`readerProcess.ts`'s 1 GiB watchdog) has no automated
  test — provoking a real hard OOM inside a unit suite is slow and
  machine-dependent.
- No per-actor fairness in the reader gate: the 2 slots and 8 waiter places
  are per process and shared by every assistant run and MCP client in it, so
  one caller reading large files can make everyone else wait or get `busy`.
- Native Word/Excel/PDF/JSON overviews have no continuation. Sheets, tables,
  chapters or warnings cut by
  `get_artifact_overview`'s page budget — or by the readers' own 5,000-entry
  caps, which OR into the same flags — are only flagged (`sheetsTruncated`,
  `tablesTruncated`, …); there is no cursor to fetch the rest. Markdown headings,
  CSV columns and YAML root-shape overviews use signed continuation.
- `read_word_table` treats row 1 as the header unconditionally (a table
  without a header row loses its first data row into `header`), and reports
  header cells **dropped** (`headerTruncated`) but not header cells
  **clamped** by `cellText`.
- The `tsx` cold start the runner pays on every call has not been measured
  inside the production images, where `--import tsx` must load per fork.
- The reader child has never been forked inside a production image at all —
  every run of it so far has been on a developer machine or in CI.

## Readers package

`packages/artifact-readers` (`@weaver/artifact-readers`) is a pure leaf
package: functions only, no side effects, and it imports nothing from
`@weaver/*`, `apps/*`, `~/`, or `node:fs`/`node:child_process`/`node:net`/
`node:http(s)`/`node:dgram`/`node:tls`/`node:worker_threads` — enforced by
`scripts/package-boundaries.test.mjs`'s "artifact readers stay pure" test.
Outside its own tests, it is imported at runtime only by
`packages/core/src/artifacts/readerChild.ts` (the forked reader child behind
the isolated file tools — see "Tools (slice 3)" above), by
`packages/core/src/artifacts/wordImages.ts` (`./archive` only, see "Word
images") and by `packages/ingestion` — the archive guard (below) and the two PDF interop
tests plus their fixture module. Its reader
subpaths are `./errors`, `./archive`, `./json`, `./yaml`, `./structured`, `./text`, `./csv`, `./pdf`, `./excel`, `./word`,
plus `./testing/pdfFixture`, `./testing/docxFixture` and
`./testing/xlsxFixture` for its fixture builders.

**The Word/Excel/PDF/JSON readers cover read paths only.**
Deliberately **not** included: every mutation/creation function
(`applyWordMutation`, `applyExcel*`, `buildBlankDocx`/`buildDocxFromTemplate`,
`buildTableWorkbook`/`buildBlankXlsx`), the Visio and draw.io readers, the
AWS-export readers (`listAws*`/`getAws*`, `summarizeAwsExport`), the
import-profile readers, and `officeZipGuard.ts` (superseded by `archive.ts`
below). No reader does OCR — a scanned/image-only PDF page returns a
"no extractable text" warning, never transcribed text. Fixtures are built in
code (this package's own `testing/{docxFixture,pdfFixture}.ts`, local helpers
in `excel.test.ts`/`archive.test.ts`); there are no checked-in binary
fixtures, and no test has read a file produced by a real Word/Excel writer or
a real PDF writer (see "How slice 3 handled it" #7).

### YAML normalization and shared JSON values

`yaml.ts` (`./yaml`) exports `parseYamlValue`, `readYamlOverview` and `queryYaml`.
Use the pinned `yaml` 2.9.1 AST API (`parseDocument`, `Document.contents`, collection
`items`, `Alias.resolve(doc)`), never unrestricted `toJS`. Parse one YAML 1.2 core
document with unique keys, no custom tags, known-tag resolution or merge behavior.
Reject errors/warnings and other version directives with fixed `ArtifactReadError`
messages; date-like plain scalars remain strings. Only finite JSON scalars,
sequences and string-keyed maps normalize. `<<` is ordinary data, not a merge.

Before materialization, validate all literal nodes/tags/keys and count at most 100
literal aliases across both mapping keys and values. Mapping-key aliases must
resolve to string scalars; reject duplicate property names after resolution and
reuse those resolved names during materialization. An iterative active-node walk rejects cycles and computes
expanded subtree counts and depths, charging the full subtree for every alias
occurrence even when its metrics are memoized. Root depth is zero; every container
edge adds one, while aliases add none. Maximum normalized depth is 512 and maximum
node count is 200,000 (each value/container, including null, counts once; property
names do not). Only then iteratively materialize independent alias copies using
own data properties, preserving names such as `__proto__` without prototype
mutation. No persistent cache or runtime imports outside the child are added.

`json.ts` owns `parseJsonValue`, `overviewJsonValue(value, sizeBytes)` and
`queryJsonValue(value, input)`. Both format readers share the latter two helpers,
preserving `JsonOverview`/`JsonQueryResult`, JSONPath filters, the existing non-RFC
slice-as-one-match behavior, pagination and flat dotted-field projection. Own-key
lookup and safe property writes apply to projection as well as normalization.
These pure interfaces support later structure readers; gateway and tool wiring
remain separate work.

### Nested JSON and YAML structure inspection

`structured.ts` (`./structured`) exports `inspectStructuredValue` and the shared
`StructuredReadInput`/`StructuredNode`/`StructuredOverview` types. `json.ts` and
`yaml.ts` expose `inspectJson`/`inspectYaml` wrappers over their parsed values.
The pointer defaults to `""`. Depth counts edges from the selected root, default 2,
accepts 0–5; node limits
default to 50 and accept 1–200. Offset is a nonnegative integer. JSON Pointers use
exact own keys with `~0`/`~1` decoding and canonical nonnegative array indices;
missing keys, invalid escapes, inherited properties and noncanonical indices
are `invalid_path`. Any exact array element is independently inspectable.

The view visits the root then children depth-first, lexical object keys and
ascending first 20 array indices. `total` counts the complete emitted-depth view,
including sampled array elements, and `nextOffset` points at the next unsent node.
Never cap intermediate object keys: a later page must reach every key. Container
`childCount` is the actual immediate count. Only arrays longer than 20 have
`sampled: true`, with `sampledCount = min(length, 20)`; objects/scalars report
false/zero. Scalar `childCount` is null. These shapes do not imply uniform arrays.

Values are absent by default. Requested `samples` take at most three immediate
scalars in traversal order (within the first 20 array elements), or the selected
scalar itself. Strings cap at 80 UTF-8 bytes on Unicode boundaries;
`samplesTruncated` marks clipped strings or additional eligible scalar omissions.
Pointers/query paths remain exact: bracketed JSONPath strings escape only quotes
and backslashes, retaining literal controls for the existing parser's unquoting
semantics. Do not JSON-encode keys or change JSONPath/projection semantics.
Combined JSON-serialized UTF-8 bytes of `{ pointer, queryPath }` cap at 8 KiB per
emitted node. Oversized addresses fail with actionable `resource_limit`, never
truncated addresses. Apply the same address cap to the selected pointer echoed in
the result header, including empty pages; validate other addresses only for emitted
nodes so unrelated pages still work.
Gateway wiring and the smaller complete-tool output budget are owned by the
shared contracts described above.

### Text and Markdown reader ownership

`text.ts` (`./text`) owns `readTextOverview`, `readText`, `searchText`, and the
shared strict UTF-8 decoder and source-line scanner. Keep these pure leaf helpers
inside the readers package; runtime parser imports remain child-only. Line and
outline limits default to 100 and max at 500; search defaults to 25 and maxes at 100. Read windows preserve original LF/CRLF/CR, omit the initial BOM, and cap raw
UTF-8 text at 128 KiB without splitting surrogate pairs or CRLF. Heading titles
and search snippets are at most 500 UTF-8 bytes; outlines page by entry count and
serialized bytes, retaining full line/heading totals.

Lines are one-based, with terminators owned by the preceding line and no phantom
empty line after a final terminator. Empty input has zero lines and EOF `(1, 0)`;
terminated EOF is `(lineCount + 1, 0)`, unterminated EOF is the last line's content
length. `charOffset` counts UTF-16 units from the line start, including terminator
units; a cursor between CR and LF is valid. Read `start` is inclusive and `end`
is exclusive, `lineCount` counts source lines touched by the returned nonempty
text (including terminators), and `nextPosition` is null at the selected range's
end. All non-null continuations point at the next unsent source character.

Markdown outlines use directly pinned `markdown-it` 15.0.2 (bundled types) in
CommonMark mode with only the public `normalize` and `block` core rules enabled.
ATX/setext heading tokens carry physical source-line maps, including list/blockquote
containers; code fences and HTML blocks/comments cannot create headings. Use raw
`inline.content` for titles, joining trimmed setext lines with spaces and applying
the existing title byte cap; never render HTML or reconstruct offsets from token
text. Normalization preserves LF/CRLF/CR line counts, while section bytes always
come from the original text scanner. Ids are `heading-<startLine>` and sections
include descendants until the next heading of equal/lower level.

Set `maxNesting: Infinity` to avoid silently dropping deep container headings;
the existing child heap/RSS/deadline bounds remain authoritative. Parser exceptions
(including stack exhaustion) become a fixed `resource_limit` with raw-line guidance,
never a partial outline or source-bearing native error. Construct the parser per
outline/section call; no parser/source cache and no Markdown parsing for ordinary
line reads or search. A section requires `markdown: true` and excludes explicit
line ranges. Search uses Unicode case-insensitive literal matching and continues
after the last returned match, with lookahead for terminal pages.

Tool assemblers that keep only a prefix must derive continuation from that actual
prefix, including cuts inside a CRLF. `textPositionAfterPrefix(start, fullWindow,
prefixLength)` supplies the leaf algorithm: pass the whole reader window to
identify CRLF correctly and a prefix ending on a Unicode boundary. Tool/core code
must preserve the child-only runtime-import boundary when consuming this logic.

### Original CSV reader ownership

`csv.ts` (`./csv`) owns `readCsvOverview`, `readCsv`, and `searchCsv`, reusing
`text.ts`'s strict BOM-aware UTF-8 decoder and literal search pattern. It reads
original string cells without table-import caps or inferred types. Delimiter
detection counts comma/semicolon/tab outside quoted fields in the first logical
record, preferring that order on ties; an explicit override wins. Headers default
on. Duplicate/empty headers and trailing empty cells keep their zero-based
indices. Headerless columns use `Column <index + 1>` display names; unnamed extra
columns in headed irregular rows have empty names. Empty source has no records;
a terminal line ending creates no additional record. Invalid quoting is a fixed
`malformed` error. Quoted cell line endings remain LF/CRLF/CR, with doubled quotes
decoded to a single quote.

Data rows are one-based and exclude the header. `rowCount` is the complete data
record count; `columnCount` is the maximum width across header and data records.
`irregularRowCount` counts data records differing from the header width (or first
data row width when headerless). Every row's `width` is its original actual width,
and `startLine`/`endLine` are inclusive one-based physical source record ranges,
including quoted multiline content but excluding a following record. These line
ranges support recovery through raw text reads.

Overview defaults to 50 columns, maximum 200; zero-based `offset` and `nextOffset`
page across every column. Header labels cap at 500 UTF-8 bytes with
`nameTruncated`; overview pages cap serialized JSON at 128 KiB. Row reads default
to 50 rows, maximum 200, starting at `startRow` (default 1). Metadata caps at 32 KiB
within the 128 KiB serialized row result budget; additive `columnCount` and
`omittedColumnCount` report source width and omitted metadata. With projection,
`omittedColumnCount` counts omitted requested metadata entries, not excluded
columns. Selected columns must be distinct existing nonnegative indices and keep
request order. A later selected column bypasses the default metadata prefix.
Short records have no invented cells for missing selected indices.

Returned cells cap at 20,000 UTF-8 bytes on Unicode boundaries with `truncated`.
`omittedCellCount` is actual row width minus returned cells, including projection
exclusions and budget omissions; truncating a returned value does not increase
it. A later row that cannot fit is left for the next page; an oversized first row
returns its bounded cell prefix (possibly empty) and explicit omissions, then
advances. `nextRow` is the next unreturned data row, never a cell continuation,
and is null after the last data row. EOF `startRow = rowCount + 1` is valid.

Search traverses complete logical data cells, including fields beyond read
truncations and rows/columns omitted from a read window. It defaults to 25 matches,
maximum 100, ordered row/column/UTF-16 offset; `charOffset` counts decoded cell
UTF-16 units (including preserved line endings), not byte or raw-source offsets.
Snippets cap at 500 UTF-8 bytes without splitting Unicode characters. Search
continuation is the position immediately after the last returned nonoverlapping
literal match, with lookahead to return null when no matches remain. A cell-end
position is valid; whole-source EOF is `(rowCount + 1, 0, 0)`. Tool assemblers that
send only a match prefix must derive their cursor from the last actually sent
match, and row assemblers must use the next actually unsent row rather than the
larger reader window's continuation. Gateway/tool assembly follows the contracts described above.

### Error codes

Every caller-actionable failure is `ArtifactReadError` (`./errors`), never a
`TRPCError`, with one of eight codes (`ARTIFACT_READ_ERROR_CODES`):
`unsupported_format`, `legacy_format`, `encrypted`, `malformed`,
`resource_limit`, `invalid_path`, `invalid_input`, `not_found`. `invalid_input`
is a bad caller argument (out-of-range limit, malformed cursor/range/id,
`endPage < startPage`); `malformed` is a bad file. Messages are always a fixed
string or echo only the caller's own input (an id, a path, a range) — never a
native library's message or file content, since those can quote the document.

### Archive guard first

`archive.ts` is the shared ZIP/OOXML guard every `.docx`/`.dotx`/`.xlsx`
reader calls before any format-specific parser opens the bytes:

- `archiveProblem(bytes)` returns one of six `ArchiveProblem` values (or
  `null`): `not_archive` (no ZIP end-of-central-directory record — keeps
  Imports' original `failureKind: "parser"` message distinct from a
  structurally-invalid ZIP), `invalid`, `encrypted`, `zip64`, `too_large`,
  `too_many_entries`. It checks **declared** sizes from the central directory
  only (`MAX_EXPANDED_BYTES` 128 MiB, `MAX_ARCHIVE_ENTRIES` 10,000).
- `assertReadableArchive(bytes)` throws the mapped `ArtifactReadError`:
  `encrypted` → `encrypted`; `invalid`/`not_archive` → `malformed`; everything
  else → `resource_limit`.
- `readArchiveEntry(bytes, name, maxBytes)` is the one **really bounded**
  single-entry reader: `inflateRawSync(raw, { maxOutputLength: maxBytes })`,
  so a part whose central-directory size field lies still can't inflate past
  `maxBytes` (distinguished from a corrupt stream via zlib's
  `ERR_BUFFER_TOO_LARGE` code, never by echoing zlib's native message). The
  Word reader reads every part (`word/document.xml`, `styles.xml`,
  `comments.xml`, headers/footers, `[Content_Types].xml`) through this
  function, 16 MiB per part (`WORD_PART_MAX_BYTES`), and does **not** use
  JSZip — JSZip is a `devDependency` used only by the test fixture builder.
  `listArchiveEntryNames(bytes)` lists central-directory names for callers
  that must discover parts whose names aren't fixed (header/footer sets).
- `readArchiveEntries(...)` reads every entry a predicate accepts in one walk
  of the central directory, for the in-process Word image lookup — see "Word
  images". Never loop `readArchiveEntry` over many names: each call rescans
  the directory.
- **A byte bound is not a memory bound.** Every bound in this package limits
  bytes read, never the heap the parsed form takes: xmldom needs roughly 100x
  the XML size in heap (8 MiB of `<w:p><w:r><w:t>a</w:t></w:r></w:p>` becomes
  ~860 MB), so even a part at the 16 MiB bound is a fatal V8 out-of-memory no
  `try`/`catch` recovers. ExcelJS hands the whole buffer to its own inflater
  at honest declared sizes, `JSON.parse` of a 50 MiB document costs hundreds
  of MB, and pdf.js's fake worker runs on the main thread and re-extracts
  every page on every call. See "How slice 3 handled it" #1.
- `packages/ingestion/src/native/archive.ts`'s `archiveIssue` is now a thin
  adapter over `archiveProblem` (see the `weaver-ingestion` skill).

### Ids are positional, not generated

- Word `blockId` (paragraph): `p-NNN`, 3-padded, 1-based, stable only for the
  same bytes (any edit renumbers).
- Word `tableId`: `table-NNN`.
- Word `chapterId`: `chapter-NNN` (`chapter-000` is synthetic front matter
  when content precedes the first heading); `document-body` is the single
  synthetic chapter when the document has no headings at all.
- No read function takes a `controlId` — the source's `requireDropdownByControlId`
  is mutation-only and was not ported; a "read this one control" function
  would be new work for slice 3.
- `readWordInstructions`, `readWordDropdowns`, and `findWordTables` take a
  **required** `input` object (the source's own signature) — callers pass
  `{}` when they have no filters, never omit the argument.

### Format-specific behaviour worth knowing

- **PDF** (`pdf.ts`): `unpdf` resolves `pdfjs-dist` into one process-wide
  singleton. The reader configures the exact same legacy `pdfjs-dist` build
  as `packages/ingestion` via a memoized `ensurePdfJs()`; `unpdf`,
  `pdfjs-dist`, and `exceljs` are pinned identically (no `^`/`~`) in both
  packages' `package.json`, guarded by `scripts/pdfjsVersionPins.test.mjs`.
  `packages/ingestion/src/native/pdfReadersInteropReaderFirst.test.ts` and
  `pdfReadersInteropIngestionFirst.test.ts` prove both load orders return
  identical results in the same process. If the pins ever drift apart,
  Imports' PDF parsing breaks with `"API version does not match the Worker
version"` the moment both packages' PDF code has run in one process.
  Out-of-range numeric limits (`maxChars`, `limit`) are **clamped**, matching
  the source (`NaN` falls back to the default), but a `startPage`/`endPage`
  that is not a positive integer and an empty (or whitespace-only) search
  query are `invalid_input`. `buildTestPdf` (`./testing/pdfFixture`) writes
  one text line per page, but pdf.js drops glyphs outside the page box, so a
  page extracts at most ~68 characters regardless of how long the source
  line is — a "long PDF" fixture needs many pages, not one long line.
- **Excel** (`excel.ts`): uses ExcelJS, not JSZip. `.xlsb` is refused as
  `malformed`, not `legacy_format` — ExcelJS doesn't recognize it as a
  workbook at all. Out-of-range numeric limits and malformed
  cursor/range/sheet-name **throw** `invalid_input` (a deliberate deviation
  from the source's silent clamping). A sheet (or range) wider than `maxCells`
  fits no whole row, so instead of returning the cursor it was given it throws
  `resource_limit` naming the column count — and, in `readExcelWorkbook`, the
  worksheet index.
- **JSON** (`json.ts`/`jsonPath.ts`): JSONPath has caps the source did not —
  200,000 matches and recursion depth 512, both mapped to `resource_limit`.
- **Word** (`word.ts` + `word/*.ts`): a malformed _secondary_ part (styles,
  comments, headers, footers) is treated as absent, matching the source —
  only `word/document.xml` itself is read strictly. `<!DOCTYPE`/`<!ENTITY`
  in any part, and any `resource_limit` from a part read, always fail the
  whole read. Block→chapter lookup is memoised (`chapterByBlockIndex`, one
  pass over the chapters) — a deliberate deviation from the source's
  per-block scan, kept because chapter lookup is on the hot path for large
  documents. The macro-enabled check (`declaresMacroEnabledContentType`)
  looks only at the **main part's own** declared content type (via its
  `[Content_Types].xml` `Override` or `Default` mapping) — an ordinary
  `.docx` that merely embeds a macro-enabled workbook still reads normally.
  A stack overflow from the recursive element walks (very deeply nested XML)
  surfaces as `resource_limit`, not a bare `RangeError`; `json.ts` does the
  same for `JSON.stringify` on an extremely deep document.

### How slice 3 handled it

This list used to bind the (then unwritten) slice-3 plan; the nine tools are
now built, so each point is recorded as what actually happened. See "Tools
(slice 3)" above for the shape, isolation and budgeting in full.

1. **Process isolation, done.** Every reader call runs in a forked child
   (`packages/core/src/artifacts/readerProcess.ts` + `readerChild.ts`) —
   Word, Excel, PDF and JSON alike — 512 MiB heap, a 1 GiB RSS watchdog, a
   60 s/120 s timeout, at most 2 concurrent children and an 8-deep wait
   queue, same pattern as Imports' native parser child
   (`packages/ingestion/src/native/isolated.ts`).
2. **Output bounding, done.** The tool layer bounds every list the readers
   hand back uncapped (Word outline and table inventory, chapter blocks,
   search matches, PDF page lists, `readJsonOverview.topLevel`, Excel sheets
   and omitted sheets) against the 16,000-character budget, reporting what
   it cut (`chaptersTruncated`, `headerTruncated`, `omittedPageTail`, …).
3. **Cursor binding, done.** `packages/core/src/services/artifactCursors.ts`
   binds every cursor to `{ tool, projectId, artifactId, contentDigest,
query }`; a replaced file fails `STALE_BASE`, any other mismatch fails
   `INVALID_CURSOR`. `read_excel_sheet`'s workbook form could not bind to a
   sheet index (see "Cursors" above) — it replays the reader's page with a
   row skip instead.
4. `readWordInstructions`, `readWordDropdowns`, and `findWordTables` still
   take a **required** input object (pass `{}`); ids are still `p-NNN`,
   `table-NNN`, `chapter-NNN` (`chapter-000` front matter, `document-body`
   when headingless); no read function takes a `controlId`. Unchanged —
   callers just needed to know it.
5. **`serverExternalPackages` never came up.** The readers are never
   imported into the Next.js bundle — only the forked child (run via `tsx`,
   outside Next's bundler) loads a reader subpath at runtime;
   `scripts/package-boundaries.test.mjs` enforces that `apps/web` cannot
   reach them at all.
6. `.xlsb` is still refused as `malformed`, not `legacy_format` (see
   "Format-specific behaviour" above); the tools pass the reader's message
   through unchanged.
7. **Still open: no test has read a file produced by a real Word/Excel/PDF
   writer.** Every fixture remains synthetic. A manual check with real files
   is still due — see "Open after this slice" above.
8. **Non-`ArtifactReadError` throws, done.** The child treats any other
   throw as a crash (`process.exit(1)`); the parent reports the fixed
   message "reading the file failed", never the native error's own text.
9. **No caching, confirmed.** Each tool call still forks and re-parses;
   `get_artifact_overview` on a Word file forks twice.
10. The Word reader functions are still declared `async` but never actually
    yield — unchanged, informational only.

## See also

`weaver-ingestion` (shared blob store, lifecycle lock, multipart parser, the
`archiveIssue` adapter over `@weaver/artifact-readers/archive`),
`weaver-assistant` (the full 36-tool registry, prompt budget, and the
"file content is untrusted data" instruction bullet), `weaver-trpc-routers`
(router conventions, error mapping), `weaver-forms-dialogs` (upload/rename/
delete dialog UX).

## OneNote notebooks

`.onepkg` and `.one` are `application/onenote` artifacts. The Files cap is
`WEAVER_ARTIFACT_MAX_FILE_BYTES` (512 MiB default and maximum, the reader's
`MAX_SOURCE_BYTES`), independent of the Imports cap. Preparation memory scales with
the largest section (a 326 MiB section peaked at ~760 MiB RSS against the 1 GiB
ceiling), so a notebook near the cap with one huge section can still fail `memory`.
`artifactNotebooks.ts` owns Viewer-authorized preparation, page search and reads;
`artifactNotebookJobs.ts` owns fenced preparation and reconciliation.
`ArtifactNotebook` binds the artifact's current digest, parser version and claim
token. Derivatives live under `WEAVER_DATA_DIR/notebooks/<project>/<artifact>/<digest>/<version>/<claim>`.
Only a fully validated snapshot becomes ready; reads recheck membership, revision
and claim. The source remains an ordinary shared blob. Missing caches become
retryable failures; the reconciler removes replaced/deleted and abandoned claims.

The ingestion worker runs `@weaver/ingestion/notebook`, which launches the Rust
reader in `packages/ingestion/native/onenote-reader` with an isolated environment,
five-minute deadline and 1 GiB RSS ceiling. `pnpm notebook:build` builds locally;
the worker Docker image includes it. Preserve the vendored parser's MPL-2.0
license and patch provenance. The native CLI and TypeScript validation share
`artifacts/notebookSchema.ts`: CAB input and snapshots are each capped at 512 MiB;
only PNG/JPEG/GIF/WebP assets with matching hashes and signatures are served.
Do not turn parser output into HTML or expose native diagnostic text.

Page images: OneNote often stores a picture in a container browsers cannot show
(ZIP-based) or not at all, plus a PNG "web picture"; the reader
(`choose_image_payload`) takes the primary image when it is PNG/JPEG/GIF/WebP,
else the web picture, and otherwise warns "image data is not included in the
notebook file" or "unsupported image format was omitted" (parser version 3).
`notebookPageText` renders image blocks as `![alt](weaver-image:<artifact
id>/<asset id>)`; document writes copy them in (see `weaver-documents`).

This is an assistant/MCP read surface. It returns text, tables and image/attachment
metadata with explicit extraction warnings. No separate notebook browser, import
workflow, editing, attachment downloads, OCR or knowledge indexing is added. The
Files page only shows each notebook's preparation state (`listArtifacts` adds
`notebook: ArtifactNotebookListState | null`, rendered by
`artifacts/_components/NotebookStatus.tsx`, polling every 5 s while queued or
running), and Background work lists it as kind `notebook` (see `weaver-jobs`).

Preparation starts on upload. `queueNotebookPreparation(tx, artifact,
requestedById)` (`artifactNotebookJobs.ts`) is the only writer of a queued row:
`finalizeArtifactUpload` and `renameArtifact` call it inside their lifecycle-locked
transaction for notebook filenames and enqueue with `requestNotebookPreparation`
after commit; `prepareArtifactNotebook` calls it with `force: true` after its own
settled/cooldown checks; reconcile calls it with a null requester for rows from an
older parser version or digest and for notebook artifacts that have no row. A
rename away from a notebook extension deletes the row. `ArtifactNotebook` also
records `requestedById`, `queuedAt`, `finishedAt` and the published manifest's
`sectionCount`/`pageCount`/`emptySectionCount`/`unreadableSectionCount`; clearing
paths spread `CLEARED_NOTEBOOK_SUMMARY`. User-facing error text for `error` codes
lives only in `NOTEBOOK_ERROR_MESSAGES` (`notebookSchema.ts`).

Cleanup goes through `sweepArtifactNotebook(db, dataDir, projectId, artifactId)`,
which keeps only the current running/ready claim, removes everything else, then
removes the emptied artifact and project directories — all under the lifecycle
lock. Delete, replace, rename-away, an unpublished build's `finally`, and the
reconcile sweep all call it; the runner creates its claim directory inside the
claim transaction so a sweep can never race directory creation. Never `rm` notebook
paths outside this function.

The manifest is `schemaVersion: 2`; each section has `content: "parsed" | "empty"
| "unreadable"`. The Rust reader classifies a section as `empty` when the parser
fails with "ObjectSpaceManifestListReferenceFND must point to a list with at least
one revision" — the section file stores no content revision, typically a cloud
section OneNote had not downloaded before the export — and warns
`EMPTY_SECTION_WARNING`. Bump `NOTEBOOK_PARSER_VERSION` whenever reader output
changes; reconcile then rebuilds existing notebooks. No local `cargo` is required:
`docker run --rm --user $(id -u):$(id -g) -e CARGO_HOME=/tmp/cargo -v
$PWD/packages/ingestion/native/onenote-reader:/reader -w /reader rust:<ver>-alpine
cargo build --release --locked` produces a static binary at the path the runner
expects.
`read_onenote` shares these services with `get_artifact_overview` and
`search_artifact_text`. Preparation is asynchronous; tools report status and
return signed, revision/query-bound cursors. Header text must be bounded by
JSON-serialized cost, with cursor space reserved before list items.

Preparation is not a pure read. Every one of the three tools calls
`prepareArtifactNotebook`, which upserts the `ArtifactNotebook` row and
enqueues `artifact.notebook.prepare` when the cache is missing or stale, and
`retry: true` re-arms a failed one. `read_onenote` therefore declares
`annotations: { readOnlyHint: false, idempotentHint: true }` on its contract
(`ToolContract.annotations` overrides the kind-derived MCP hints in
`packages/mcp/src/tools.ts`); `get_artifact_overview` and
`search_artifact_text` keep `readOnlyHint: true` for their other formats, so
an MCP client auto-approving read-only tools should know that on a OneNote
artifact those two may also enqueue preparation. `prepareArtifactNotebook`
first looks at the row **without** the lifecycle lock and answers directly
when the cache is current (a ready notebook never queues behind uploads,
renames or deletes); only a missing/stale row or an accepted retry takes
`withProjectIngestionLifecycleLock` and re-checks the same conditions inside
it. A retry of a preparation failure (`parse_failed`, `parse_timeout`, a
memory kill) inside `NOTEBOOK_RETRY_COOLDOWN_MS` (10 minutes from the row's
`updatedAt`, i.e. from when the failure was recorded) is refused without a
job: the response keeps `status: "failed"` with `retryRefused: true`, and
such a failed overview carries `retryAllowedAt` (ISO time, null once the
cooldown has passed). A `snapshot_unavailable` failure — a lost or damaged
cache, not a deterministic parse failure — is exempt: `retryAllowedAt` stays
null and `retry: true` rebuilds immediately, so the cache-recovery hint keeps
working. The tools turn the cooldown into a hint naming the time; do not
throw for it.

Published snapshots count against the project quota: the runner stores the
validated tree's byte total in `ArtifactNotebook.snapshotBytes` when it
publishes `ready` only after a lifecycle-locked quota check; an over-quota
snapshot is removed and its row fails `quota_exceeded`. `retainedBytes` (`ingestion/blobReferences.ts`) adds
the `snapshotBytes` of the project's `ready` rows (excluding the artifacts a
replace is about to supersede) to the original blobs. Re-queueing and
invalidation reset it to 0. `reconcileArtifactNotebooks` isolates each row:
a throwing row (a re-dispatch after the worker runtime stopped, for one) is
collected, the remaining rows and `sweepNotebookSnapshots` still run, and an
`AggregateError` is thrown at the end.

Run `pnpm notebook:test`, the ingestion runner unit tests, and
`pnpm test:integration:artifacts` (includes notebook services and tools). The
real user notebook is a private local fixture and must never enter Git.

Missing-cache failures carry `SNAPSHOT_UNAVAILABLE` in core and are translated by
notebook-local tool handling into explicit `read_onenote`, `action="sections"`,
`retry=true` instructions. Overview/search status responses name the same tool;
they do not accept `retry` themselves. Preserve authorization/revision/cursor
errors. Queued/running preparation asks callers to wait, and failed rebuilding
must be reported instead of producing a retry loop.

Explicit HEAD downloads authorize and return metadata without opening a blob or
acquiring a download slot. Uploads share persistent per-user concurrency and
project staging reservations with Imports; see `weaver-ingestion`. The multipart
`beforeFile` hook reserves once before opening the first sink, after replacement
fields have been read. Replacement declarations grant no admission credit before manifest validation;
retained originals and other active reservation bytes still count. Notebook publication counts active
reservations as well as retained content.

## Review hardening invariants

Upload reservations grant no replacement credit before the uploaded manifest is known. Downloads must handle signals already aborted during blob opening through the same idempotent cancel/release path. Post-commit notebook enqueue errors defer to reconciliation and do not skip cleanup or change the accepted artifact result. Archive guards verify actual expansion within declared per-entry sizes and the aggregate budget before JSZip consumers.
