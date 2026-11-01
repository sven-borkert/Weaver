---
name: weaver-entity-tables
description: Use when building or modifying Weaver list views, entity tables, columns, filtering, sorting, pagination, search, or row selection.
---

# Entity tables, pagination, filtering, sorting

Weaver ships the project-members UI table and the cursor-paged Imports batch
list on this pattern. The Documents and Tables browse routes moved off it to
a shared folder explorer — see **weaver-documents** and **weaver-tables** —
but the underlying `document.list`/`table.list` contracts below are still
live for their other callers.

## Key files

| Path                                                                                        | Role                                                                                      |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `apps/web/src/app/(workspace)/projects/[projectId]/settings/_components/MembersSection.tsx` | Small unpaged members table: shadcn `Table` + role `Select` per row + remove confirmation |
| `apps/web/src/components/ui/table.tsx`                                                      | shadcn table primitives (`Table`, `TableHeader`, `TableRow`, `TableCell`, …)              |
| `packages/core/src/services/projectMembers.ts`                                              | `listMembers` — returns all rows; sorted server-side by role rank desc, then email        |
| `apps/web/src/server/api/routers/projectMember.ts`                                          | `projectMember.list` procedure (Viewer+)                                                  |
| `apps/web/src/server/api/schemas/document.ts`                                               | Current document page/search/sort input contract                                          |
| `packages/core/src/services/documents.ts`                                                   | `listDocuments` — project-scoped query, count, stable sorting, paging envelope            |
| `apps/web/src/server/api/routers/document.ts`                                               | `document.list` procedure (Viewer+)                                                       |
| `apps/web/tests/integration/documents.spec.ts`                                              | Document list paging, search, sorting, All, and authorization coverage                    |

## Current implementations

### MembersSection

- The members table renders every row (no pagination — membership lists are small); build new small reference-style lists the same way on `apps/web/src/components/ui/table.tsx`.
- Sorting happens in the service (`PROJECT_ROLE_RANK` desc, then `user.email`), not the client. Keep ordering deterministic and server-side.
- Per-row actions gate on the caller's role before rendering (`canManage` from the settings page); role changes are inline `Select`s wired to `projectMember.updateRole`, removals go through a confirm dialog (weaver-forms-dialogs).

### `document.list` (API contract, no longer the Documents browse UI)

- `document.list` is a paged entity contract: `page >= 1`, `pageSize` 0–200
  (default 50; 0 means All), optional case-insensitive title substring
  `search`, `sort: "title" | "lastEditedAt"`, and `dir: "asc" | "desc"`. It
  returns `{ items, total, page, pageSize, pageCount }`.
- Document filtering and sorting happen in PostgreSQL after Viewer access is
  asserted. The requested sort is always followed by `id asc` as the stable
  tiebreaker. In All mode the returned `pageSize` is `total` and `pageCount`
  remains 1, including an empty result.
- Neither the Documents nor the Tables browse route calls this procedure
  directly — both render the shared folder explorer instead
  (`ContentExplorerScreen` + `ContentExplorer` under
  `apps/web/src/components/explorer/`, folder state in `?folder=`, driven by
  a per-kind `ExplorerAdapter`: `documentsExplorerAdapter` backed by one
  unpaged `folder.tree` query, `tablesExplorerAdapter` backed by
  `tableFolder.tree`; pure client-side helpers in `lib/documents/explorer.ts`
  and `lib/tables/explorer.ts`; see **weaver-documents** and
  **weaver-tables**). `document.list` remains live for its other callers:
  `CrossReferencePicker.tsx` and the document-typed cell editor in
  `TableCellEditors.tsx`, both of which do need server-side search/paging over
  potentially many documents outside a single folder view. Keep this
  contract's paging/sort/search behavior when changing it — those callers,
  and `apps/web/tests/integration/documents.spec.ts`'s direct-caller
  coverage, depend on it. `table.list` is the equivalent still-live contract
  for tables: used by `CrossReferencePicker.tsx`'s table picker and by
  cache-invalidation helpers, never by the explorer itself.

### TableGrid

- Table list/tree mutations render only for project Editor+ membership with content-write capability (see **weaver-auth**).
  A Viewer still opens, filters, sorts, pages, and follows table rows, but no
  mutation trigger is rendered. Nested title/Open/action controls stop row
  activation.
- Cached list/tree data remains visible only after a transient refresh error,
  with a local Retry action. `NOT_FOUND`, `FORBIDDEN`, and `UNAUTHORIZED`
  immediately replace cached entities and mutation controls with the same
  nonsensitive missing/inaccessible presentation.
- The AG Grid detail is draft-local: sorting, filtering, widths, selection,
  and horizontal scrolling never become save input. Its center boundary is
  `min-w-0`, selection count is announced politely, and narrow toolbars expose
  the same row, column, and Save actions as wide toolbars.
- Viewer copying uses AG Grid Community's `enableCellTextSelection` together
  with `ensureDomOrder`; do not add Enterprise clipboard/range-selection APIs.

## Future list UI conventions

When a later paged entity UI extends these conventions:

- **Client state:** page/pageSize/search/sort in plain `useState` unless the product explicitly requires shareable URL state; `{ placeholderData: keepPreviousData }`; pass `pageCount ?? 1` (0 breaks out-of-range clamping); a filter change resets to page 1 and clears dependent filters.
- **Selection & bulk actions:** build checkbox selection in (header select-all over the shown rows); chunk bulk deletes instead of one unbounded mutation.
- **Columns:** stable string keys per column (users' column preferences hang off them); abbreviated headers for wide sets; row actions in a trailing column that stop click propagation.
- Every new list procedure gets a "list pagination and sort" block in `apps/web/tests/integration/<entity>.spec.ts` (weaver-testing).

## Common mistakes

| Mistake                                            | Reality/Fix                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| Client-side sorting for a server-paged list        | Sort server-side (whitelist fields), deterministic tiebreaker    |
| Assuming every list uses the same All sentinel     | Documents send `0`; tables send `-1`; preserve each API contract |
| Filter change without page reset                   | Empty out-of-range pages; reset to page 1                        |
| Hand-rolling per-row checkboxes without select-all | Build selection in once, tri-state header included               |
| Rendering actions the caller's role can't perform  | Gate on `myRole`/`canManage` before rendering                    |
| Unbounded bulk deletes                             | Chunk them                                                       |

## See also

- weaver-ui-pages (page structure, nav, styling), weaver-forms-dialogs (row action dialogs), weaver-trpc-routers (list procedure shape), weaver-testing.
- CLAUDE.md Standing Rule #4; `docs/IMPLEMENTATION.md` UI section.

### Cursor-paged lists

Imports uses `BATCH_PAGE_MAX` and opaque, project-bound cursors from `packages/core/src/services/ingestion.ts`. Preserve the complete page envelope and derive continuation from the last emitted row; do not mix offset and cursor contracts.
