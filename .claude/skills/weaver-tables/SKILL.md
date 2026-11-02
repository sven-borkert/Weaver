---
name: weaver-tables
description: Use when changing Weaver typed tables, Git-backed schema/data storage, grid editing and row identity, table/folder organization, history/recovery, appearance preservation, or table transfer between instances.
---

# Weaver Tables

Shared storage primitives use `weaver-git-store`; machine HTTP grants/publishing use `weaver-project-api`; peer connection/refresh and receiver HTTP behavior use `weaver-remote-instances`. Table-specific formats, grid behavior and conversion rules remain here.

## Server foundation

- Tables are Git-backed beneath the reserved repo root `tables/`; document
  paths must not enter that root.
- `SchemaFile.appearance` is optional metadata in `schema.json`; the exact
  two-file table leaf layout stays unchanged. `tables/jsonl.ts` recognizes
  only that additional key and keeps rejecting other unknown keys. Shared
  `appearance/metadata.ts` normalizes lowercase six-digit colors, the finite
  builtin icon allowlist, single-grapheme icons (64 UTF-8 bytes, no controls)
  and SHA-256 PNG/JPEG/WebP references. Bad optional appearance fields are
  dropped while valid table content stays readable; canonical writes omit
  empty appearance. `DataTable.appearance` is a nullable projection slot.
  Image icon paths are `.weaver-icons/<digest>.<png|jpg|webp>`, outside leaves.
- A table lives in a `<slug>.table` directory. Folder paths are relative to
  `tables/`, and folder trees hide those table-leaf directories.
- `DataTable` is the rebuildable projection of a Git-backed table. Moving or
  renaming a table folder must rewrite matching `DataTable.path` rows after the
  Git commit.
- Core table behavior lives in `packages/core/src/services/tables.ts`; Git is content
  truth, every committed read requires the exact two-file layout and derives
  its base SHA in Git ancestry order. Under the per-project repository critical section,
  `getTable` can recover a missing or stale projection by bounded UUID lookup,
  and `saveTable` resolves stale paths from schema/data rename evidence before
  writing. Move/delete also rediscover the current Git directory under that
  lock, so a stale or missing projection cannot target the wrong path. Moves
  detect same-folder no-ops from that recovered directory before consulting
  projection collisions, validate a real tables-folder destination, allocate
  around index/worktree/Git history collisions, and do not rewrite
  `schema.updated`; delete is recoverable only through Git, with no trash or API
  undelete. Stale saves use a rename-aware three-way merge in that same critical
  section: clean results pass the normal validation/caps, commit once with
  `(merged)`, and return canonical merged state; conflicts write nothing and
  carry descriptors plus the committed table SHA. Projection writes use a
  database transaction, duplicate-tolerant inserts, and project-and-table-id
  scoped convergence checks so races cannot mutate foreign ownership. Failures
  after a successful Git commit are logged without hiding that commit;
  `getTable` likewise logs repair drift and returns already-validated Git truth.
- History is the ancestry-ordered union of rename-following `schema.json` and
  `data.jsonl` logs. Same-SHA entries retain every directory reported by either
  file log, then history accepts the commit only when exactly one canonical
  directory contains both capped files and its committed `schema.id` matches
  the requested table. Newest-first offset paging and `hasMore` count only
  those validated entries, continuing the bounded Git walk past foreign,
  incomplete, or ambiguous candidates. Entries are attributed through the
  shared trailer/email resolver and expose the reconciled table-directory
  `pathAtSha`. Identity discovery caps canonical table directories rather than
  unrelated project files, limits concurrent Git object reads, and reports a
  controlled precondition error when the table-count ceiling is exceeded.
  History and diff recover the current directory from Git rather
  than trusting a stale projection. Diff reads both requested versions through
  their historical directories, verifies both `schema.id` values, and returns
  structured title/column/row/cell changes. It returns `{ tooLarge: true }`
  before diffing when either side exceeds 10,000 rows, 100 columns, or 200,000
  represented row×column cells.
- Restore requires Editor+, runs inside the project repository critical
  section, verifies the source snapshot belongs to the requested table, and
  submits its title/columns/rows to the shared update writer at the current Git
  base. The writer preserves the current Git id/created timestamp, advances
  `updated`, applies normal rename/collision allocation, commits once with the
  source short SHA, and treats projection failure as post-commit repairable
  drift.
- **Recovery:** a deleted table is Git-recoverable. The assistant/MCP
  `content_history` (mode=deleted) and `propose_content_restore`/
  `restore_content` tools (content tools slice 3, design §6) discover
  recoverable tables from committed `D` (delete) records in Git history —
  never from commit messages or trailers — so a table removed through the web
  UI is found too. Recovery preserves the original schema UUID, refuses to
  overwrite a live table that already holds that id, and writes a new commit
  rather than rewriting history.
- Maintainer rebuild opens only an existing repository under the shared
  project advisory lock, pins one `HEAD`, and validates sorted canonical two-file table
  snapshots without changing Git. Malformed, incomplete, over-cap, duplicate,
  or foreign-owned candidates are reported and skipped; the surviving
  project-global ids/slugs/paths replace only that project's `DataTable` rows
  in one transaction. Rebuild derives row count from validated JSONL, created
  time from the schema, and last editor/time/SHA from the ancestry-latest schema
  or data commit. It never rebuilds `DocumentLink` or a table-cell projection.
- `writeTableInRepo` is exported so Phase 4D's `assistantProposals.ts` can
  commit an accepted table proposal (create/schema-change/rows) through the
  same write tail as the router; its `TableWriteMetadata` takes an optional
  `operationId`, recorded as the commit's `Weaver-Operation-Id` trailer, and
  an optional `runId`, recorded as `Weaver-Run-Id`. `getTable` takes its own
  shared project lock (`withExistingProjectRepoReader`) — a caller already
  holding the exclusive lock via `withProjectRepo` (proposal acceptance
  included) must not call it, since a shared-lock request against a
  same-process exclusive holder blocks forever; use the repo-scoped
  `getTableInRepo` on the already-open `repo` handle instead.
- Shared input schemas are in `apps/web/src/server/api/schemas/table.ts`.
  `apps/web/src/server/api/routers/table.ts` exposes `list/get/history/diff/backlinks`
  to Viewer+, `create/save/move/delete/restore` to Editor+, and `rebuildIndex`
  to Maintainer+; nonmembers and missing tables receive `NOT_FOUND`.
- `table.importCsv` (Editor+) creates a table from a dropped `.csv`/`.tsv` file.
  `packages/core/src/tables/csv.ts` parses delimiter-detected, quote-aware CSV
  text (`parseCsv`) and infers a column's type (`inferColumnType`, in
  precedence order: number, datetime, date, boolean, url, longtext, else
  text) from its non-empty values; `coerceCsvCell` converts a raw cell under
  that type. `packages/core/src/services/tableImport.ts`
  (`importCsvTable`) caps input at `MAX_DATA_FILE_BYTES` (`tables/validation.ts`,
  5 MB), truncates/dedupes column names to the 100-character cap before
  `columnNamesFromHeader`, derives the title from the file name
  (`documents/importMarkdown.ts`'s `titleFromFileName`), and writes through the
  same `createTable` tail as the create dialog — one commit, one
  `notifyProjectContentChanged`.
- Column types (`packages/core/src/tables/types.ts` `COLUMN_TYPES`): `text`,
  `number`, `date`, `datetime`, `select`, `multiselect`, `boolean`, `url`,
  `longtext`, `document`. `hasOptions(type)` is true for `select`/`multiselect`
  only — every options-gating check (schema, `table.change`'s `option_add`,
  the column dialogs' options editor) uses it instead of a literal
  `type === "select"`. `CellValue` is
  `string | number | boolean | string[]`; only `multiselect` uses the array
  shape (a deduped, order-significant list of option ids). `cellValuesEqual`
  (`tables/cellValues.ts`) is the array-aware equality check — the grid draft
  (`lib/tables/draft.ts`) and `isDraftDirty`/`setDraftCell` use it instead of
  `===`/`!==` so reassigning an identical array is a no-op and a reordered one
  is dirty.
- Validation (`packages/core/src/tables/validation.ts`): `isValidDateTimeCell`
  requires an explicit time zone (`Z` or `±HH:MM`) with optional seconds;
  `isValidUrlCell` requires an `http(s)` scheme (case-insensitive) and caps at
  `MAX_URL_CHARS` (2,048); `MAX_TEXT_CHARS` (10,000) also bounds `longtext`;
  `MAX_MULTISELECT_VALUES` (200) bounds a multiselect cell's array length, on
  top of the shared 200-option-per-column cap.
- Core limits are 10,000 rows, 100 columns, 5 MB `data.jsonl`, 250 KB
  `schema.json`, 10,000 characters per string cell (`text`/`longtext`), 2,048
  characters per `url` cell, 200 options per select/multiselect column, and
  200 selected values per multiselect cell. UUIDs, duplicates, column-specific
  cell values, titles, and schema timestamps are validated before commit.
- Retype (`retypeDraftColumn` in the UI, persisted through `table.save`;
  `table.change`'s `retype` op for coherent changes) is atomic: it converts
  every populated cell under the new type, and a single
  cell that fails conversion blocks the whole retype (the draft/change is left
  unchanged). A `select<->multiselect` retype keeps the column's option list;
  every other target type sheds it. `table.change`'s `retype` performs no
  implicit coercion at all — an invalid cell under the new type fails final
  validation, and the caller must supply explicit cell updates in the same
  change (`retypeColumn`/`convertCellValue`, used by the UI path, is not
  reused there).
- All table, column, option, row, cell-key, and document-cell UUIDs use
  canonical lowercase form. Raw submitted schema/data byte budgets are checked
  incrementally before semantic validation or merge, then exact serialized
  outputs are checked again.
- Document crossrefs may target tables with `weaver://table/<id>`.
  `DocumentLink.targetType` preserves that identity, label and reference
  lookups are project-scoped, and unresolved table targets remain indexed.
  Table backlinks validate current same-project Git truth, select only typed
  table targets, and return project-scoped source documents in stable order;
  document backlinks remain document-only.
- Shared scoped-folder behavior is in `packages/core/src/services/folders.ts`.
  `packages/core/src/services/tableFolders.ts` adapts it for `tables/`, and
  `apps/web/src/server/api/routers/tableFolder.ts` exposes `tree/create/rename/move/delete`.
  Table-folder trees pin one Git HEAD and use projected leaves for existing
  schema/data paths, repairing missing descendant paths only. Full content
  reconciliation belongs to rebuild; grid rendering does not wait for the tree.
  Each `TableTreeLeaf` also carries `rowCount`, `lastEditedAt`, and
  `lastEditedBy`, which the tables explorer adapter maps into `TableItem` for
  the Rows column and the shared "Last edited"/"By" columns.
- Folder and item lifecycle have lock-free `…InRepo` variants
  (`createFolderInRepo`, `moveFolderToInRepo`, `deleteFolderInRepo`,
  `moveDocumentInRepo`, `deleteDocumentInRepo`, `moveTableInRepo`,
  `deleteTableInRepo`) so `applyOperationInRepo` can commit them inside a lock
  the caller already holds. They carry no access check — the exported wrappers
  hold the `assertProjectRole(..., "Editor")` call — so any new caller must
  assert Editor itself before invoking one. The exported wrappers are thin
  `withProjectRepo` callers and keep their existing signatures; never call one
  from inside another project write lock.
- Path rules live in `packages/core/src/tables/paths.ts`; focused coverage is in
  `apps/web/tests/integration/tables.spec.ts`,
  `apps/web/tests/integration/tableHistory.spec.ts`,
  `apps/web/tests/integration/tableFolders.spec.ts`,
  `apps/web/tests/integration/tableCrossrefs.spec.ts`, and
  `apps/web/tests/integration/folders.spec.ts`.
- The typed query language (filter schema, `coerceFilterValue`, `matchesFilter`,
  `compareCells`, `filterRows`) lives in `packages/core/src/tables/query.ts` and
  aggregation in `packages/core/src/tables/aggregate.ts`.
  `packages/assistant-tools/src/tools/tables.ts` re-exports only what its
  callers already imported from it — `coerceFilterValue`, `compareCells`,
  `compareIds`, `matchesFilter`, `tableFiltersSchema`, `tableSortSchema` and
  the `TableFilter` type — so `queryRows` and its callers are unchanged;
  `filterRows`, `columnsById` and `requireColumn` are core-only and must be
  imported from `@weaver/core/tables/query`. Core throws `CoreError`, which
  `toolErrorFromUnknown` maps to the same tool code and message.
- Query/aggregate semantics for the new types: `datetime` orders and
  equality-compares by parsed instant (`dateTimeInstant`), not string
  identity, so cells with the same instant in different zones sort and match
  as equal. `multiselect` supports `contains` (a single option id),
  `eq`/`neq` (an order-insensitive set of option ids), and rejects ordering
  filters (`lt`/`lte`/`gt`/`gte`); `url` and `longtext` allow
  `contains`/`eq`/`neq` as plain strings but likewise reject ordering
  filters. `aggregate_table`/`aggregate.ts` accept `datetime` for `min`/`max`;
  `distinctCount` on a `multiselect` column counts distinct option ids across
  rows, not distinct arrays; `groupAndAggregate`'s group-by explodes a
  `multiselect` column into one candidate per option id it holds (cartesian
  with any other group-by column), so a row with two selected options can
  land in two buckets.

Run `pnpm test:integration apps/web/tests/integration/tables.spec.ts` after changing the
core write service/router, and the focused `tableHistory.spec.ts` after changing
history, diff, or restore. Run the focused table-folder spec after changing
scoped folder behavior. The authorized tables Tier-2 area set is
`pnpm test:integration:tables`.

## Client files and rules

| File under `apps/web/src/`                                                          | Responsibility                                                                                |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `app/(workspace)/projects/[projectId]/tables/page.tsx`                              | Renders the shared `ContentExplorerScreen` with `tablesExplorerAdapter`                       |
| `app/(workspace)/projects/[projectId]/tables/_components/tablesExplorerAdapter.tsx` | Table `ExplorerAdapter`: `tableFolder.tree`, Rows column, CSV import                          |
| `app/(workspace)/projects/[projectId]/tables/_components/TableScreen.tsx`           | Canonical snapshot/draft, save, conflict, history and navigation                              |
| `app/(workspace)/projects/[projectId]/tables/_components/TableGrid.tsx`             | AG Grid adapter and batched document-reference resolution                                     |
| `app/(workspace)/projects/[projectId]/tables/_components/TablesWorkspace.tsx`       | Editor-only context rail shell (list/icons navigation lives in the shared explorer, not here) |
| `lib/tables/explorer.ts`                                                            | `TableItem`, `tablesBase`/`tableHref`, tree-leaf to explorer item mapping                     |
| `lib/tables/csv-drop.ts`                                                            | Partitions dropped files into importable `.csv`/`.tsv` vs. ignored                            |
| `lib/tables/draft.ts`                                                               | Immutable structural updates and order-insensitive sparse-cell equality                       |
| `lib/tables/grid.ts`                                                                | Coercion, stable row adapters and column editors                                              |
| `lib/tables/presentation.ts`                                                        | Validated conflict descriptors and readable row/column labels                                 |
| `lib/tables/table-cache-invalidation.ts`                                            | Mutation cache ownership                                                                      |

The shared explorer (`components/explorer/ContentExplorerScreen.tsx`,
`ContentExplorer.tsx`, `adapter.ts`) and its list/icons-view UI are documented
in `weaver-ui-pages`; `weaver-documents` covers the same components from the
documents side. Modifier-click selection, folder/group dragging and serial bulk
move/delete reuse existing table/tableFolder endpoints. Table deletion captures
each revision before confirmation; failed entries remain selected. Viewer table
browsing stays read-only, and folder deletion still requires an empty folder.

- Keep the canonical snapshot/draft as the sole save source. Grid sort, filters,
  widths and selection never become persisted table state. Copy only changed
  rows/columns, preserve unchanged references, and memoize dirty comparisons.
- Use AG Grid Community with route-local `AgGridProvider`/`AllCommunityModule`.
  Support text, number, date, datetime, select, multiselect, boolean, url,
  longtext and document columns. Select editors include an empty option;
  Delete/Backspace clears a focused cell outside editing. Whitespace-only
  numeric input clears a sparse value. Viewer columns are read-only.
  Type-specific editors/renderers (`TableCellEditors.tsx`, wired into
  `lib/tables/grid.ts`'s column defs and `TableGrid.tsx`'s `components` map):
  `dateTimeCellEditor` is a native `<input type="datetime-local" step="1">`
  seeded with the cell instant's own offset (keeping its seconds when
  non-zero); a non-empty but unparsable edit keeps the prior cell value
  rather than clearing it. `multiselectCellEditor` is a popup listbox
  (`role="listbox"`, options `role="option"` with checkboxes) that commits on
  every toggle, in `column.options` order, so a grid-driven stop (click away,
  Tab) never silently drops an in-progress selection; an empty selection
  clears the cell. `url` cells get a plain text editor and an anchor renderer
  guarded by `isValidUrlCell` (an invalid stored value renders as plain
  text, no link). `longtext` cells use AG Grid's `agLargeTextCellEditor` plus
  a first-line preview renderer with a grid-level Expand dialog (rendered
  once at `TableGrid.tsx`, not per-cell, so AG Grid recycling the cell can't
  unmount an open dialog) that shows the value through `AssistantMarkdown`.
- Resolve distinct document-cell IDs in capped batches using the ordinary
  `document.resolveRefs` query keys. Failed/foreign/broken targets remain generic
  `Unavailable document` values. Never issue a resolver query for each cell.
- Complete active editor commits before Save and adopt only `snapshotFromWrite`
  responses, including merged saves and restores. Cache-refresh errors after a
  successful write are warnings, not failed saves. Preserve dirty work on refetch.
- Validate unknown conflict descriptors and a canonical `headCommitSha` before
  presenting conflict actions. A valid SHA with absent descriptors also opens the
  conflict dialog with a general explanation. Invalid descriptors remain a save
  error. Reload discards only after confirmation and a successful committed fetch.
- There is no "All tables" button. The editor's own restore and
  reload-committed actions each confirm once and preserve open drawers after
  cancellation, through their own dialogs. Leaving the editor via the
  breadcrumb — like documents — relies on the shared
  `useUnsavedChangesGuard`'s `beforeunload`/click-intercept guard rather than
  a per-navigation confirm, since the breadcrumb link is plain. The
  breadcrumb "Tables" link from a table goes to the tables root; folder
  crumbs above the title link to that table's own folder, same as documents.
  Other list filters/paging stay local; All is `-1`.
- Collapsed desktop context occupies a dedicated 3rem grid column; never float
  its expand button over the editor toolbar. Empty lists omit the page counter
  when the server returns zero pages.
- Delete requests from list actions carry the displayed `headCommitSha`; a stale
  revision returns CONFLICT before deleting. Saved schemas over row/column caps
  return PRECONDITION_FAILED for restore; oversized diff copy must not promise
  unconditional restore.
- Check project membership and content-write capability for every control. Viewer
  keeps read/copy/history/diff; Maintainer+ gets rebuild. Keep context preference
  safe, mount query-backed rails only while open, and preserve accessible focus
  handoffs for triggerless dialogs. Describe invalidated rows by row number.
- Mutation success uses shared cache invalidation. Folder changes invalidate
  descendant identity readers; typed document/table crossrefs use `type:id` keys.
- Historical slug paths remain reserved for stable rename history. Collect them
  once per allocation, not one Git history traversal per suffix candidate.

## Coherent changes

`table.change` (`propose_table_change`/`change_table`,
`packages/core/src/tables/change.ts`) changes a table's title, columns,
select options and rows together in one revision.

- Column changes apply, then row changes, then one final `validateRows` over
  the combined result — an intermediate state (e.g. a retyped column before
  its cells are converted) is never checked on its own, so a retype and its
  explicit conversions succeed together in one operation.
- Row cell `set`/`clear` are both explicit; a column id in both is rejected.
  `false`, `0`, and `""` are values, not clears.
- Retype performs no implicit coercion (deliberately does not reuse
  `retypeColumn`/`convertCellValue`): values invalid under the new type fail
  final validation with `INVALID_FINAL_STATE`, telling the caller to supply
  explicit cell updates in the same change.
- Removing a select or multiselect option needs an explicit cell update for
  every row that still references it; `validateRows` rejects a cell whose
  option id no longer exists, so a bare `option_remove` without those updates
  fails for either type — there is no automatic cascade that strips the id
  from multiselect cells. `option_add` accepts any `hasOptions` column
  (select or multiselect); a `select<->multiselect` retype with no explicit
  `options` keeps the existing option list (any other target type sheds it).

## Sending to another Weaver instance

"Send to another Weaver…" is a slot in `TableToolbar`'s header
(`extraActions`, visible to every role including Viewer, not just when
`canEdit`) rendering `SendToRemoteDialog`. It sends the saved revision
through `remoteInstance.sendTable` → `sendTableToRemote`
(`packages/core/src/services/remoteInstances/transfer.ts`), which reads the
table's current title, columns and rows with the normal `getTable` and posts
them as-is — no crossref rewriting or image collection applies to tables. The
receiving instance creates a fresh table with no history, attributed to the
receiving user; `createTable` has no provenance parameter, so unlike a sent
document, a sent table's commit carries no `Weaver-Operation-Id` trailer. See
`weaver-auth` for the peer OAuth client and `weaver-admin` for the registry.

## Verification

Use `pnpm test:integration:tables` or the focused integration specs listed above.
Run colocated `lib/tables` and core table unit tests for adapter/merge changes,
plus `pnpm check` for UI changes. Browser coverage lives in
`apps/web/tests/e2e/tables.spec.ts`; run only through `pnpm e2e` with Tier 3
consent and validated `.env.e2e`. See `weaver-testing` for harness details and
`docs/IMPLEMENTATION.md` for the workspace layout and feature map.

Project overview pins are PostgreSQL shortcut state keyed by project, kind and
resource UUID. `ProjectContentPin` deliberately has no foreign key to `DataTable`:
projection rebuild deletes/recreates rows. Keep the canonical table UUID stable
through rename, move and rebuild so pins resolve again. Unavailable pins consume
the 12-slot capacity and are exposed only as typed placeholders to pin curators.

Restore and delete require the viewed `expectedHeadCommitSha` and compare it
under the repository lock before mutation. Tree deletion loads a version before
enabling confirmation when the tree has no version token. Table titles share
`documentTitleSchema`; history offsets are capped at 1,000 and immutable blob
lists use a bounded 16-entry cache.

## Review hardening (September 2026)

CSV imports decode UTF-8/UTF-16 BOMs with a Windows-1252 fallback, skip blank records,
and preserve numeric-looking identifiers with leading zeroes or `+` as text. Dates
and date filters require real `YYYY-MM-DD` values. Select sorting uses labels;
select filters accept only known ids with `eq`/`neq` (plus empty checks). Missing
cells sort last in either direction. Datetime grouping and distinct counts compare
instants. Retyping an option column to a non-option type requires explicit populated
cell replacements or clears. Removing and re-adding a column id never restores old
cells. Merged saves retain insertion positions and reject incompatible concurrent
reorders. Conflict dialogs offer a JSON draft export before reload. History, diff
and backlink reads hold the shared repository lock; history checks schema ids before
full snapshot reads and caps candidate scanning at 2,000 commits.

## Appearance writes and preservation

`services/contentAppearance.ts` performs metadata-only Editor writes under the
same project Git lock and guards the loaded table revision. Its optional image
bytes are validated and committed with `schema.json` in one commit at the
reserved project icon root. Appearance writes leave `schema.updated` and table
content unchanged. `repairTableProjectionInRepo` uses the scoped projection
repair path; post-commit drift is logged without rolling back accepted Git.
All projection writers, lists, trees and rebuilds carry normalized appearance.
The table writer preserves the current schema's appearance when reconstructing
schema for a normal save, stale content merge or content restore. Deleted-table
recovery instead passes the recovered schema's appearance into the create path.
Folder trees expose the scope-relative `folderAppearances` map at the same Git
snapshot as names/stamps; folder rename/move preserves appearance. The tables
root uses key `""` and `tables/.folder.json` without a visible folder entry. See
weaver-documents for atomic rollback and icon-serving contracts.

Remote table transfers preserve optional appearance and referenced icon bytes through
`createTable`'s existing locked create pipeline. `iconAssets` are SHA-256/type/2 MiB
validated before `withAppearanceAssetsInRepo` stages the icon with the two table
files in one commit; pre-commit rollback removes all newly written files. The
reserved project root keeps table leaves at exactly `schema.json` + `data.jsonl`.
Image-bearing sends preflight the receiver's `contentAppearance=1` capability;
legacy payloads remain accepted and CSV export stays data-only.
`getTable` returns the captured project `snapshotCommitSha` alongside the item
`baseCommitSha`. Transfer appearance and icons use that project snapshot; an
asset-only icon repair does not advance the table's concurrency revision.

## Grantable folder identities

Non-root table folders use the same optional canonical .folder.json UUID as
document folders. New folders receive an ID; moves, appearance and metadata
writes preserve it. projectApi/folderIdentity.ts resolves scope-relative paths
from committed metadata under the existing lock and denies duplicate IDs.
Tables root is a separate explicit grant marker, never a non-root folder UUID.
Do not assign IDs inside .table leaves or copy source IDs when importing folders.

Project machine writes use a separate content author (`services/contentAuthor.ts`); they never gain membership. Preserve the machine editor pair (`lastEditedByMachineKind`/`Id`, dual-writing `lastEditedByProjectKeyId` this release) and captured name when rebuilding, and clear the prior machine stamp on human edits/moves. Machine publishing flows through `projectApi/operations.ts` with operation→project locks and revision/idempotency guards. Operation locking has its own `WEAVER_PROJECT_API_OPERATION_LOCK_POOL_MAX` (1–128, default 2) so single-connection repository/application pools remain safe.

Project API crash recovery uses `repairTableProjectionInRepo` with
`{ throwOnError: true }` and schedules table indexing before settling its receipt.
Ordinary callers retain best-effort projection repair. Recovery always reads current
Git state so later edits or deletions are preserved.

## Review hardening invariants

Every historical table lookup requires ancestry of a pinned HEAD, including diff, restore and stale-save bases.
