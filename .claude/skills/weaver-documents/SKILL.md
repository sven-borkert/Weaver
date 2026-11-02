---
name: weaver-documents
description: Use when changing Weaver Git-backed documents, the rich/raw Markdown editor, cross-references, folders, images, history/diff/restore, document review and reviewer groups, archive import/export, Git remote push/pull or document transfer.
---

# Weaver documents

Git is authoritative for document content and history. PostgreSQL `Document`
and `DocumentLink` rows are derived projections that `rebuildIndex` can repair.

Shared repository readers, advisory locks, recovery and transport primitives use `weaver-git-store`. Project-machine publishing uses `weaver-project-api`; peer connection/refresh and receiver HTTP rules use `weaver-remote-instances`. Document-specific review, editor, Git pull merge and conversion rules remain here.

## Core files

| Path                                                                                                                                       | Role                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/git-store/src/gitStore.ts`                                                                                                       | Per-project repositories, advisory locking, recovery, atomic files, attribution                                        |
| `packages/core/src/services/documents.ts`                                                                                                  | Shared create/update/restore pipeline, Git-truth reads/history/diffs, slug allocation                                  |
| `packages/core/src/services/documentChangeSummaries.ts`                                                                                    | Save-then-queue AI change comments, the worker job, and reconcile                                                      |
| `packages/core/src/services/documentLinks.ts`                                                                                              | Exact outgoing-link projection sync                                                                                    |
| `packages/core/src/documents/images.ts`                                                                                                    | Pure image rules: sniffing, names, assets paths, src classification, prefix rewrite                                    |
| `packages/core/src/services/documentImages.ts`                                                                                             | Stores uploaded images in Git and reads committed image blobs for serving                                              |
| `apps/web/src/app/api/documents/[documentId]/pdf/route.ts`                                                                                 | Viewer-gated PDF download of the saved revision (`server/documents/pdf/export.ts` assembles it)                        |
| `apps/web/src/server/documents/pdf/{html.ts,render.ts,runtime.ts,limiter.ts}`                                                              | Print HTML (viewer markup + light print styles), Chromium renderer with a per-process queue, runtime check             |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/DocumentActionsMenu.tsx`                                          | Header "⋯" menu: graph, review, PDF (disabled with a reason when `useRuntimeStatus().pdf` is missing), ZIP, send       |
| `apps/web/src/app/api/documents/[documentId]/images/route.ts`                                                                              | Editor-only multipart image upload route                                                                               |
| `packages/core/src/services/documentDownload.ts`                                                                                           | `readDocumentFile` (stored `.md`), `createDocumentArchive`/`createFolderArchive` (ZIP of a document or folder)         |
| `packages/core/src/documents/{archive.ts,archiveZip.ts}`                                                                                   | Pure file selection for a folder archive and the streaming ZIP writer                                                  |
| `apps/web/src/app/api/documents/[documentId]/markdown/route.ts`                                                                            | Viewer-gated download of the stored Markdown file                                                                      |
| `apps/web/src/app/api/projects/[projectId]/folders/archive/route.ts`                                                                       | Viewer-gated ZIP download of a documents folder (`?path=`; none is the project root)                                   |
| `apps/web/src/lib/documents/download.ts`                                                                                                   | Download links the explorer, its menus, and the drag payload share                                                     |
| `apps/web/src/app/api/projects/[projectId]/files/[...path]/route.ts`                                                                       | Viewer-gated committed image serving with ETag and optional `?at=<sha>`                                                |
| `apps/web/src/lib/documents/image-url.ts`                                                                                                  | Pure relative-src → serving-URL resolution for reader and editor                                                       |
| `apps/web/src/lib/editor/document-image.ts`                                                                                                | `DocumentImage` TipTap extension rendering relative sources through `resolveSrc`                                       |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/DocumentImageNodeView.tsx`                                        | Saved-path image provider and editor NodeView with resize handles and size buttons                                     |
| `packages/core/src/services/folders.ts`                                                                                                    | Git-backed folder tree/create/rename/move/delete                                                                       |
| `packages/core/src/documents/indexLight.ts`                                                                                                | `documentIndexLights` computes keyword/semantic/graph lights from index state                                          |
| `packages/core/src/documents/importMarkdown.ts`                                                                                            | Frontmatter title extraction, file-name fallback title, sanitized import title                                         |
| `packages/core/src/documents/kinds.ts`                                                                                                     | Kind registry: `documentKindFromPath`/`documentKindOfPath`/`documentKindFromFileName`, `documentFileStem`              |
| `packages/core/src/documents/text.ts`                                                                                                      | Plain-text validation for Python content and imports                                                                   |
| `packages/core/src/documents/pythonOutline.ts`                                                                                             | `pythonDefinitions` lexical scan and `documentOutlineFor(kind, text)`                                                  |
| `apps/web/src/lib/editor/python-editor.ts`                                                                                                 | CodeMirror 6 setup for Python documents (dynamic import)                                                               |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/PythonDocumentEditor.tsx`                                         | Python editor: no toolbar, read-only for Viewers, `<pre>` fallback                                                     |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/PythonOutlinePanel.tsx`                                           | Contents tab list of `def`/`class` definitions                                                                         |
| `apps/web/src/lib/documents/use-text-document-session.ts`                                                                                  | Text-document save/discard/conflict session with cause-based `textResetKey`                                            |
| `packages/core/src/documents/importPython.ts`                                                                                              | `splitPythonImport`: Weaver header strip, file-stem title for uploaded `.py` files                                     |
| `packages/core/src/services/documentImport.ts`                                                                                             | `importDocumentFile` (plain `.md`/`.py` file) and `importDocumentArchiveEntry` (ZIP document with its images)          |
| `packages/core/src/documents/frontmatter.ts`                                                                                               | Hidden comment header (version 3, review block) + title heading; reads legacy YAML and version 2                       |
| `packages/core/src/documents/review.ts`                                                                                                    | Pure review rules: `DocumentReview`, `reviewDueAt`, `addMonthsUtc`, canonical reviewer order, limits                   |
| `packages/core/src/services/documentReview.ts`                                                                                             | Mark reviewed, change review settings, `reviewPermissions`, the due list/count, `reviewerFilter` (effective reviewers) |
| `packages/core/src/services/reviewerGroups.ts`                                                                                             | Reviewer groups, project review defaults, `defaultReviewFor`, `resolveImportedReview`                                  |
| `packages/core/src/services/documentHeaderUpgrade.ts`                                                                                      | `upgradeDocumentHeaders`: legacy YAML, missing authors and missing review blocks                                       |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/{DocumentReviewLine,MarkReviewedDialog,ReviewSettingsDialog}.tsx` | Header review line, mark-as-reviewed confirm, review settings dialog                                                   |
| `packages/core/src/editor/markdown.ts`                                                                                                     | Deterministic TipTap JSON ↔ Markdown conversion and crossref labels                                                    |
| `packages/core/src/editor/mermaid.ts`                                                                                                      | Dedicated Mermaid Markdown/HTML atom and adaptive fence handling                                                       |
| `packages/core/src/editor/math.ts`                                                                                                         | `inlineMath`/`mathBlock` atoms, `$` delimiter rules, repair of formulas saved as text                                  |
| `apps/web/src/lib/editor/math-render.ts`                                                                                                   | The one KaTeX call (`trust: false`, `maxSize`), shared by reader, editor and PDF                                       |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/MathNodeView.tsx`                                                 | Rendered formula; click opens the LaTeX source popover when editable                                                   |
| `apps/web/src/server/documents/pdf/mathStyles.ts`                                                                                          | KaTeX stylesheet with fonts inlined; PDF printing blocks every request                                                 |
| `packages/core/src/editor/imageTag.ts`                                                                                                     | Image width bounds and the one accepted `<img>` tag: parse, render, tokenizers                                         |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/DocumentCodeBlock.tsx`                                            | Code block copy button: reader mapping and client-only editor node view                                                |
| `apps/web/src/lib/editor/mermaid-render.ts`                                                                                                | Rejection-safe strict initialize+render serialization across client diagrams                                           |
| `packages/core/src/knowledge/sectionAnchors.ts`                                                                                            | Canonical Markdown heading-path and duplicate-anchor allocation                                                        |
| `apps/web/src/lib/documents/section-navigation.ts`                                                                                         | Validated source/anchor URLs, stale fallback, feedback, and highlight cleanup                                          |
| `apps/web/src/lib/documents/use-document-section-navigation.ts`                                                                            | Shared section scroll/highlight and focus policy without save replay                                                   |
| `apps/web/src/lib/editor/document-heading-anchors.ts`                                                                                      | Canonical heading anchors shared by static rendering and editor decorations                                            |
| `apps/web/src/lib/editor/document-section-anchors.ts`                                                                                      | Client-only TipTap anchor decorations without document mutations                                                       |
| `apps/web/src/lib/editor/render.tsx`                                                                                                       | Static reader mapping that applies the canonical heading anchors                                                       |
| `apps/web/src/server/api/routers/document.ts`                                                                                              | Thin document read, write, reference-resolution, and backlink procedures                                               |
| `apps/web/src/server/api/routers/folder.ts`                                                                                                | Thin folder procedures                                                                                                 |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/page.tsx`                                                                     | Folder/list route composed by the shared `ContentExplorerScreen` with `documentsExplorerAdapter`                       |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/[documentId]/page.tsx`                                                        | Detail route composed by `DocumentScreen`                                                                              |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/DocumentsWorkspace.tsx`                                           | Shared page header, scrolling canvas, and context rail (no tree)                                                       |
| `apps/web/src/components/explorer/ContentExplorerScreen.tsx`                                                                               | Shared URL-folder explorer screen (tables and documents): tree query, search, sort, view, states                       |
| `apps/web/src/components/explorer/ContentExplorer.tsx`                                                                                     | Shared list/icons item views, roving focus, context menus, driven by an `ExplorerAdapter`                              |
| `apps/web/src/components/explorer/adapter.ts`                                                                                              | `ExplorerAdapter<I>` interface (tree, import, columns, copy, actions) documents and tables both implement              |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/documentsExplorerAdapter.tsx`                                     | Documents' `ExplorerAdapter`: `folder.tree`, Markdown import, index-light column                                       |
| `apps/web/src/lib/explorer/entries.ts`                                                                                                     | Shared pure direct-children, recursive search, sort, parent helpers (generic over item kind)                           |
| `apps/web/src/lib/documents/explorer.ts`                                                                                                   | Documents-specific re-exports over `lib/explorer/entries.ts` (`DocumentItem`, `documentsBase`, `documentHref`)         |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/IndexLights.tsx`                                                  | Three-dot keyword/semantic/graph index status with an accessible failure-summary tooltip                               |
| `apps/web/src/lib/documents/document-drop.ts`                                                                                              | Pure document-file (`.md`/`.markdown`/`.py`), `.zip`, other file partition for the explorer drop zone                  |
| `apps/web/src/app/api/documents/[documentId]/archive/route.ts`                                                                             | Viewer-gated ZIP download of one document with its images                                                              |
| `apps/web/src/app/api/projects/[projectId]/documents/import/route.ts`                                                                      | Editor-gated import of one ZIP document per multipart request                                                          |
| `apps/web/src/server/documents/archiveImportFields.ts`                                                                                     | Bounds and parses that request: fields, Markdown and images                                                            |
| `apps/web/src/lib/documents/{zip-import.ts,zip-import-read.ts,zip-import-upload.ts}`                                                       | Pure ZIP analysis, targets and collisions; the only browser JSZip caller; per-document upload                          |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/ImportZipDialog.tsx`                                              | Review dialog for a dropped ZIP: contents, structure choice, collisions, progress, summary                             |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/DocumentScreen.tsx`                                               | Document/diff state, role gating, and query coordination                                                               |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/DocumentEditor.tsx`                                               | Persistent directly editable canvas and save/discard/conflict controls                                                 |
| `apps/web/src/lib/documents/draft-state.ts`                                                                                                | Saved-baseline equality, revision-aware acknowledgements, and history reset                                            |
| `apps/web/src/lib/documents/reconcile-document-content.ts`                                                                                 | Minimal saved normalization preserving selection mappings and unrelated undo steps                                     |
| `apps/web/src/lib/documents/use-document-session.ts`                                                                                       | Save, refresh, discard, and conflict coordination                                                                      |
| `apps/web/src/lib/documents/use-document-images.ts`                                                                                        | Cancellable uploads with selection bookmarks mapped through edits                                                      |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/EditorToolbar.tsx`                                                | Permanent header formatting/insertion toolbar and selection-preserving forms                                           |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/document-toolbar-groups.ts`                                       | Toolbar group/command model shared by the row and the More menu                                                        |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/DocumentToolbarControls.tsx`                                      | Single-row groups, toolbar menus, and priority+ overflow into More formatting options                                  |
| `apps/web/src/lib/editor/callout-commands.ts`                                                                                              | Wrap the touched blocks in a callout, change its type, or unwrap it                                                    |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/useDocumentPresentation.ts`                                       | Shared live reference resolution and section navigation                                                                |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/DocumentCrossref.tsx`                                             | Resolved reference provider and client-only TipTap NodeView                                                            |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/DocumentHeader.tsx`                                               | Shared title/metadata and the action slot (Save/Discard, Source toggle, actions menu)                                  |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/ContextRail.tsx`                                                  | Contents/Links/History/Index tabs shared by desktop rail and mobile drawer; Index queries only while visible           |
| `apps/web/src/app/(workspace)/projects/[projectId]/documents/_components/DocumentOutlinePanel.tsx`                                         | Contents tab: heading outline, section jumps, and the current-section marker                                           |
| `apps/web/src/lib/documents/use-document-outline.ts`                                                                                       | Live editor outline (anchor plugin state) with the saved-content fallback                                              |
| `apps/web/src/lib/documents/use-outline-scroll-spy.ts`                                                                                     | Current section from the `[data-document-canvas]` scroll position while the Contents tab is visible                    |
| `apps/web/tests/e2e/documents.spec.ts`                                                                                                     | Canonical serial Phase 1 browser workflow                                                                              |

## Repository and file contract

- Each project is a non-bare repository at
  `${WEAVER_DATA_DIR}/git/<projectId>/` with a `main` root commit.
  `createProject` initializes it and commits a root `project.json` (id, name,
  description, created, members with roles) through
  `packages/core/src/services/projectMetadata.ts`; settings and membership
  writes re-sync that file, and `withProjectRepo` still initializes lazily for
  older projects. Documents are `<folder>/<slug>.md` or `<slug>.py`; empty folders use
  `.gitkeep`. Folder, document, and table code must keep ignoring the root
  metadata file (it is not `.md` and adds no directory).
  A folder's display name and create/update stamps live in `<folder>/.folder.json`
  (`{"id", "name", "created", "createdBy": {id, name}, "updated", "updatedBy"}`,
  `documents/folderMetadata.ts`; the stamps are optional when reading):
  `createFolderInRepo` writes it, `renameFolderInRepo` rewrites it and moves the
  directory only when the slug changes, and a rename or move keeps `created*` and
  sets `updated*` to the actor (`touchedFolderMetadata`, read from `HEAD` before
  the `git mv`). "Updated" means the folder itself changed, not its content. A
  folder without the file is left without one by a plain move.
  Document headers may carry a `properties` line after `appearance`
  (`wiki/properties.ts` `normalizeProperties`, tolerant on read; columns
  `Document.wiki*`/`reviewExempt`). Every header rewrite must pass `meta.properties`
  through; `reviewExempt` pages get no review block; `type: source` grants nothing.
  Non-root folders now carry an optional canonical UUID `id`; newly created
  folders always receive one. Preserve it through metadata/stamp/review/appearance
  updates and moves. `projectApi/folderIdentity.ts` assigns legacy IDs only when
  granting a folder, without changing stamps; its HEAD-scoped bounded maps deny
  missing/duplicate identities. ZIP copies allocate destination IDs and existing
  destination folders keep theirs. Document/table root grants use scope markers.
  Document kinds live in the registry `documents/kinds.ts`: never test
  `.endsWith(".md")`; use `documentKindFromPath`/`documentKindOfPath`. A Python
  file starts with an optional shebang, then a `# weaver` … `# /weaver` comment
  block holding the same fields as the Markdown header, the title as a
  `# title: "<JSON>"` line; `composeDocumentFile`/`parseDocumentFile` take a
  required kind. `document.get` returns `kind` and
  `content: { kind: "markdown", contentJson } | { kind: "python", text }`;
  `document.update` takes the same `content`.
  `.gitkeep`/`.folder.json` are the marker files an empty folder may hold.
  `folder.tree`/`tableFolder.tree` return `folderNames` and `folderStamps` (path →
  name / stamps with current user names, read in one `readBlobsAt` batch); a
  missing or malformed file falls back to the slug and shows no stamps.
  Document folders also carry optional `reviewDefaults: { reviewers }`, using
  `StoredFolderReviewDefaults` in `documents/folderReview.ts`. Invalid optional
  defaults are omitted; valid references use the existing `ReviewerRef` shape,
  canonical UUIDs/names, at most 50 entries, and `canonicalReviewers` order.
  `closestFolderReviewDefault` checks whole-segment ancestors from nearest to
  root: missing defaults inherit, explicit `reviewers: []` stops inheritance
  for the existing Owner fallback. It does not resolve current membership.
  Root `.folder.json` is parsed/composed by `parseRootFolderMetadata` /
  `composeRootFolderMetadata` as defaults only; name, appearance and stamps do
  not belong to it. Normal parsing still requires a usable display name.
  `readRootFolderMetadataAt` (`services/folders.ts`) reads that root at an
  explicit revision. Tree reads return normal document `folderReviewDefaults`
  and optional `rootReviewDefaults` separately, without a visible root entry;
  table trees have no review defaults. Rename/move preserves defaults alongside
  appearance and the existing creation stamps; `upgradeFolderMetadata` also
  retains parsed appearance/defaults while filling missing stamps.
  `services/folderReview.ts` also owns folder default reads, Maintainer preflight,
  guarded recursive assignment and clearing. Preview/apply share pure preparation
  from one Git inventory, including documents absent from the projection. The
  folder router owns `reviewDefaults`, `previewReview`, `setReviewRecursively`
  and `clearReviewDefault`; mutation inputs carry `expectedHeadCommitSha`. Apply
  rechecks access, expected project HEAD and current reviewer targets under the
  writer lock; it sets the selected default, clears descendant overrides, skips
  unchanged files and rejects more than 1,000 rewrites or 50 MiB of rewritten
  document bytes before touching the worktree. Each composed document also passes
  `documents.assertDocumentFileSize` during preparation; an overflow rejects both
  preview and apply with its path before any batch writes. Folder metadata updates its own
  stamps; document authors, clocks, history, appearance and body stay intact.
  Folder/root controls use `documents/_components/FolderReviewDialog.tsx`; root
  access comes from the document adapter's optional `rootActions`, without a
  visible root folder or a Tables action. Initialize from configured references,
  keep dirty picker selections across refresh, strip names from target inputs,
  and show effective reviewers/inheritance separately. Preflight is keyed by the
  selected targets and obsolete requests are cancelled; Apply uses that preview's
  HEAD. Clear uses the defaults read HEAD and affects only the selected setting.
  `invalidateFolderReview` refreshes document and review/default caches without
  resetting dirty editor baselines; normal content saves then encounter conflict.
  Default reads expose both effective `reviewers` and `configuredReviewers`.
  The configured selection keeps canonical Git names/identities (including
  unresolved refs) and explicit `[]`; absent ancestor settings use the project
  configuration without materializing Owner fallback. `getConfiguredProjectReviewers`
  and `reviewFromConfiguredDefaults` in `reviewerGroups.ts` keep configured and
  effective selection on one chosen setting read while resolving current names.
  Mutations strictly validate raw `reviewDefaults` presence and shape on every
  affected folder/root before writes; ordinary metadata reads remain tolerant.
  Clear changes only the selected default. Failed writes restore originals and
  clean newly staged files; an accepted commit remains authoritative even if
  its acknowledgement or projection fails. `documents.projectPreparedDocumentInRepo`
  reuses normal metadata/reviewer/link projection and index signaling without a
  repeated Git inventory; failure uses `reportProjectionFailureAndReconcile`.
  Assignment emits normal project-content notification, never AI summaries.
  `folder.previewMarkReviewed`/`markReviewedRecursively`
  (`previewFolderMarkReviewed`, `markFolderReviewed` in the same service) mark a
  folder subtree reviewed: any member with `content:write` may call them, and only
  documents the actor is an effective reviewer of (`effectiveReviewerDocumentIds`,
  the projection row's path must match the Git path) get `lastReviewed`/`reviewedBy`;
  the rest, unparseable files included, are counted as skipped. One commit
  `review: mark folder reviewed <path>` under the same HEAD guard, limits, rollback
  and projection as assignment; `updated*`, reviewers and interval stay, no AI
  summary. UI: `MarkFolderReviewedDialog.tsx`, opened by "Mark all as reviewed" in
  the folder menu (shown to Viewers too) and beside the root reviewer button.
  `services/folderReview.ts::defaultReviewForFolderInRepo` reuses the supplied
  writer and reads ancestor/root settings at its current locked HEAD. Never
  acquire another repository lock in this resolver. New documents materialize
  current member/group names and project interval; explicit empty or entirely
  ineffective defaults use Owner fallback. Creation from UI, content operations,
  accepted ingestion and remote transfers all share `writeDocumentInRepo`.
  Internal `reviewSource: { kind: "import", imported }` carries raw review metadata
  into that writer for Markdown/ZIP imports; never add it to public tRPC inputs.
  `resolveImportedReview` accepts already resolved folder defaults and keeps
  known source reviewers/interval while resetting the clock/history. ZIP Replace,
  saves and moves preserve current review; deleted recovery preserves valid
  review metadata or resolves defaults with the recovery-time clock.
  Newly staged ZIP folders inherit committed destination ancestors: imported
  names/appearance do not introduce source reviewer-default settings.
  `upgradeFolderMetadata` (`services/folderMetadataUpgrade.ts`, `system.reconcile`)
  fills missing stamps from the marker file's Git history, one `chore: add folder
metadata` system commit per project gated by `Project.folderMetadataVersion`. The
  image route refuses it like `project.json`.
- A document file is deterministic Markdown: a hidden HTML comment header
  (`<!-- weaver`, then `id`, `created`, `createdBy`, `updated`, `updatedBy`,
  `reviewers`, `reviewEvery`, `reviewSince` and, only once reviewed,
  `lastReviewed` and `reviewedBy` lines, then `-->`), a blank line, the title as the leading `# ` heading
  (`composeTitleHeading` backslash-escapes `\ ` * _ [ ] < & ~`and a trailing`#`; `parseTitleHeading`reverses it), a blank line, then the body. The title
is not a header field, so other Markdown viewers show it and hide the rest.
IDs are canonical UUIDs; timestamps are ISO-8601 UTC; an author is canonical
JSON`{"id":"<uuid>"|null,"name":"<1–200 chars, one line>"}`with`>`written
as`\u003e`so nothing closes the comment early. `parseDocumentFile`also
reads the YAML frontmatter files had before`DOCUMENT_HEADER_VERSION`2 (Git
history keeps them;`legacy: true`) and version 2 headers without the review
lines (`meta.review`is null); writers only ever compose the current format
(version 3).`createdBy`/`updatedBy`are null only for files written before
authorship existed.`upgradeDocumentHeaders` (`services/documentHeaderUpgrade.ts`,
in `system.reconcile`) rewrites legacy files, fills missing authors from Git
history and adds missing review blocks in one system commit per project
(`chore: upgrade document headers`, or `chore: add document review metadata`when only review blocks were added), selecting projects by`Project.documentHeaderVersion`(new projects start current) or by projection
rows without author names or review columns; a row whose file no longer parses
is named`Unknown author`so the project leaves the pending set. The pass
processes at most 500 documents per project and run and completes over
successive passes; every block added in one pass shares one`reviewSince`per
project (the project defaults via`defaultReviewFor`). Rows that no usable file
backs (repair finds no file carrying the id) are drained with projection-only
defaults so they leave the pending set. The rewrite changes
every blob, but keyword sync carries vectors and graph across identical chunks
(`keywordIndex.ts`), so nothing is extracted again. `authorForUser`
(`documents/frontmatter.ts`) names a user by display name, else email, as one
  line of at most 200 characters. Versions live only in Git.
- Optional `appearance` is canonical JSON in one line after the review block
  in version-3 document headers, and a field in `.folder.json`. It uses
  `appearance/metadata.ts` (`normalizeAppearance`, `assertAppearancePatch`,
  `applyAppearancePatch`): absent/empty settings serialize without a field;
  readers drop invalid appearance fields without rejecting content. Comment
  JSON keeps the existing `>` escaping. Colors are lowercase six-digit hex;
  icon rules and the builtin allowlist live in `appearance/{metadata,icons}.ts`.
  Image references point to `.weaver-icons/<sha256>.<png|jpg|webp>`, outside
  document assets and table leaves. `Document.appearance` is a nullable,
  rebuildable projection slot, not content truth.
- Metadata defaults: create sets both timestamps and both authors to now/the
  actor; a content write sets `updated`/`updatedBy`; a move or rename changes
  none of them (review fields are carried over unchanged, see below).
  `document.create`/`edit`/`patch` take an optional `metadata`
  (`documentMetadataInputSchema`, `resolveDocumentMetadata` in
  `contentOperations.ts`): timestamps never in the future and `updated >=
created`; an author is `{ userId }` of a current project member (named from
  the account) or `{ name }`. A patch may carry only metadata. A commit that
  sets fields adds `Weaver-Metadata-Override: <fields>`; the commit author stays
  the real actor. Proposal previews list the set fields.
- The projection mirrors the frontmatter in `Document.createdAt`/`createdById`/
  `createdByName`/`updatedAt`/`updatedById`/`updatedByName`
  (`documentMetadataColumns`; an id links only when that user exists here).
  `lastEditedAt`/`lastEditedById` stay "last commit touching the file" for
  activity and dashboards. Reads present authors with the account's current
  name (`presentAuthor`); the documents explorer shows Created/Created by and
  relabels its edited columns Updated/Updated by from the metadata.
- Recently reviewed list: `listRecentlyReviewed` (`review.listRecent`, `/reviews/recent`)
  reads only the projection columns (`lastReviewedAt`, `reviewedById`/`Name`,
  `reviewDueAt`), one row per reviewed document, newest first, for any member
  of the project (not limited to reviewers). Rebuild Index re-creates those
  columns from the file headers, so the list is rebuildable; there is no event
  log. The sidebar has a "Reviews" section with Open (`/reviews`, due badge,
  reviewers only) and Recently reviewed; the rail keeps one icon.
- Document review. `meta.review`
  (`DocumentReview`: `reviewers`, `everyMonths` 1-120, `since`, `lastReviewed`,
  `reviewedBy`) is nullable: files without the block still parse, projection
  review columns are nullable, and the upgrade pass fills them. `reviewers` is
  canonical JSON (0-50 `{type: user|group, id, name}` sorted by type then id, no
  duplicates); `lastReviewed`/`reviewedBy` are written together or not at all.
  `reviewDueAt` = `since` while `lastReviewed` is null (a never-reviewed
  document is due immediately), else `lastReviewed` + `everyMonths` UTC calendar
  months, day clamped (`documents/review.ts`, the only place the formula lives).
  Write rules: create (UI, proposals, MCP, drafts, remote transfers) resolves
  `defaultReviewForFolderInRepo` at the writer's locked HEAD (nearest folder/root,
  then project defaults, Owners when empty/ineffective; `since` = now, never reviewed);
  import keeps only the file's reviewers known in the project (the defaults when
  none remain) and its interval, with `since` = now and no `lastReviewed`/
  `reviewedBy` (`importedReview` + `resolveImportedReview`; a block that does not
  parse counts as absent and gets the defaults); the projection clamps
  future-dated blocks that arrive by other routes; a ZIP
  "Replace" and every content save/restore/move/rename keep the existing block;
  `recoverDeletedInRepo` keeps the block, or gives a block-less file the
  defaults with the clock starting at recovery. Marking reviewed and changing
  settings (`services/documentReview.ts`) are metadata-only commits
  (`review: <path>`, `review settings: <path>`): `updated`/`updatedBy` stay, no
  AI change-summary job is queued, authorization is re-checked under the
  repository lock, a stale head is `CONFLICT`, and a settings change that alters
  nothing writes nothing and returns the current head. Projection
  `lastEditedAt`/`lastEditedById` do move with a review commit (last commit
  touching the file). Changing the interval moves the due date of a reviewed
  document and never the clock; a never-reviewed document stays due at `since`.
  Projection: `Document.reviewEveryMonths`/`reviewSince`/`lastReviewedAt`/
  `reviewedById`/`reviewedByName`/`reviewDueAt` and one `DocumentReviewer` row
  per header entry, written by `documentMetadataColumns` and
  `syncDocumentReviewers` (`syncDocumentsReviewers` batches a rebuild); a row
  links `userId`/`groupId` only for a current member or existing group; the
  projection computes `reviewDueAt` from `lastReviewed`/`since` clamped to now
  (`dueAtFrom`), so a future `since` of a never-reviewed pulled document is due
  now, and a future `lastReviewed` puts the due date at most one interval after
  the last projection (each re-projection moves it). UI wording: a document
  without `lastReviewed` reads "Not reviewed yet · Review due now" (no date). Every project membership create/remove path (`addMember`, `removeMember`,
  admin `setUserMembership`, `ensureOwnerMembership`) calls
  `linkUserToProjectReview`/`unlinkUserFromProjectReview`
  (`services/projectReviewerLinks.ts`) in its transaction so `userId` links,
  groups and defaults stay current.
  Effective reviewer rule, defined once in `reviewerFilter`
  (`documentReview.ts`): a current project member who is named, belongs to a named
  group, or is an Owner of a document with no resolvable reviewer (no row with a
  current member, none with a group that still has members). Reads
  (`getDocument`/`getDocumentAtSnapshot` `review`, `presentDocumentReview`) show
  current names and `resolved`; `listDocuments` returns `reviewDueAt`. The read
  tools shared by MCP and the in-app assistant (`read_document`,
  `list_documents`) return the review fields; there are no write tools. The
  UI: the header shows `DocumentReviewLine`, the header's `DocumentActionsMenu` ("⋯", accessible name "Document
  actions") holds every secondary action: Explore graph (hidden while dirty),
  Mark as reviewed for effective reviewers and Review settings for Maintainers
  and above (both disabled while the editor is dirty), Export as PDF, Download
  as ZIP and Send to another Weaver. Only Save/Discard and the Viewer's Source
  toggle stay buttons; add new secondary actions to the menu, not the header.
  The menu owns the open state of the controlled `MarkReviewedDialog`,
  `ReviewSettingsDialog` and `SendToRemoteDialog`, which render outside the
  menu content and return focus to its trigger; both review dialogs take the head commit explicitly (the editor passes its session baseline,
  the viewer the loaded document's) and stay busy until the refreshed
  `document.get` has arrived. `invalidateDocumentReview` invalidates both
  `review.listDue` and `review.listRecent` after review writes. For a document without a block the settings dialog
  is prefilled from the project defaults and saves both fields; changing the
  reviewers drops entries no longer in the project (the dialog says so). The
  documents explorer has no "Review due" column (no optional-column mechanism);
  instead `folder.tree` documents carry `reviewDueAt`/`lastReviewedAt` and the
  adapter's `itemBadge` renders `ReviewStatusIcon` beside the index lights:
  check (reviewed, not due within 30 days), amber clock (due within 30 days or
  never reviewed), red alert (overdue), from `documentReviewStatus` in
  `lib/documents/review-status.ts`. Its never-reviewed wording matches the
  header line.
  Groups, defaults and `project.json` (`documentReview`, `reviewerGroups`) are in
  `services/reviewerGroups.ts`/`projectMetadata.ts`; the database is their source.
- Document images live in a flat `<folder>/<slug>.assets/` directory beside the
  document. It is never created empty and carries no `.gitkeep`. Weaver-generated
  names match `^[a-z0-9][a-z0-9-]{0,79}\.(png|jpg|webp|gif)$`, collisions append
  `-2`, `-3`, …, and nameless input becomes `image-<yyyymmdd>-<hhmmss>`. Upload
  commits are `asset: <assets path> (for <document path>)` and never touch the
  `.md`. Markdown keeps plain relative `![alt](<slug>.assets/<file>)` links.
- Writes through `document.create`/`edit`/`patch` (MCP and proposals) may use
  image references (`documents/imageReferences.ts`): `weaver-image:<artifact
id>` for a PNG/JPEG/WebP/GIF file in Files, `weaver-image:<artifact id>/<asset
id>` for an image of a prepared OneNote notebook (`read_onenote` renders page
  images this way) or of a Word file (the asset id is the media part's SHA-256,
  looked up by `findWordImages` in `artifacts/wordImages.ts`, one scan per
  Word file for all the pictures a write references; Word reads render
  pictures this way). `resolveImageReferences` (`services/documentImageImports.ts`,
  called by `createImages`/`updateImages` in `contentOperations.ts`) reads each
  source with the writer's own access, enforces `WEAVER_DOCUMENT_IMAGE_MAX_BYTES`
  and at most 100 images per write, stores them as `image.png`, `image-2.png`, …
  beside existing assets and rewrites the links, all in the document's own
  commit (update requests carry `assets` like creates). A bad reference is
  `BAD_REQUEST` on `markdown` naming it. Proposals check references at proposal
  time with `checkImageReferences` (metadata only: the file exists here, is an
  image, fits the limit — except that a referenced Word file is read to find
  its pictures; its failure reasons are listed in `weaver-artifacts` "Word
  images") for the preview line "Images: N copied into the
  document" and copy the bytes at acceptance. The Markdown file import
  (`services/documentImport.ts`) resolves references with the importer's access.
- Images are block nodes. `parseDocumentBody` lifts an image that Markdown put
  inside a paragraph (next to text or another image) into its own block, keeping
  the surrounding text as paragraphs, wherever the parent's schema allows it
  (`liftInlineImages`); elsewhere, e.g. a list item's first paragraph, the
  content still fails validation.
- An image may carry a `width` attr: whole pixels, 16–4096 (`imageWidth` in
  `editor/imageTag.ts`; `validateDocumentContent` rejects anything else). There
  is no height, percentage, alignment or caption. An image with a width is
  written as `<img src="…" alt="…" [title="…"] width="N">` on its own line
  (attribute order fixed; `&`, `"`, `<`, `>` entity-escaped; tab, line feed and
  carriage return as `&#9;`, `&#10;`, `&#13;`, so the tag is always one line);
  an image without one keeps `![alt](path)` byte for byte. "Reset size" sets
  `width: null`.
- That tag is the only HTML the parser reads, and `parseImageTag` is the whole
  grammar: lowercase `<img`, then one or more ` name="value"` attributes from
  `src`, `alt`, `title`, `width`, `height` (each at most once, double-quoted,
  no raw `<`, `>`, `"` or line break in a value; `&amp; &quot; &lt; &gt; &#39;
&#9; &#10; &#13;` decoded), optional ` /`, `>`, all on one line. `src` must
  pass `classifyImageSrc` or be a well-formed `weaver-image:` reference
  (`parseImageReference`). `height` is dropped; an invalid or missing `width`
  leaves an image without width (saved back as plain Markdown). Anything else —
  other tags, attributes, quoting, casing, sources — keeps the raw-HTML handling
  it always had. Do not widen it: Markdown arrives from imports, Git pulls, the
  assistant and MCP clients.
- The tokenizers never create an image. `ImageTagInline` emits the tag's source
  as a text node with the transient `imageTagSource` mark, so bold and links
  around it apply as to any text. `ImageTagBlock` claims a tag that stands alone
  on its line together with the lines up to the next blank line (the extent of
  the HTML block marked would have read) and returns a paragraph whose inline
  content is parsed and whose transient `imageTagBlock` attr keeps the source.
  A tag line never interrupts the paragraph above it; inside a list item, where
  marked reads text line by line, it starts that claimed block. `liftInlineImages`
  then turns marked text into image nodes and lifts them only where the existing
  rule for Markdown images succeeds; everywhere else (a heading, a table cell or
  header, the start of a list or task item) the node goes back to the literal
  text, marks included, that the parser produced before tags were read. Neither
  marker may leave `parseDocumentBody` (`imageTag.test.ts` checks a corpus), and
  the raw `MarkdownManager` output still carries them: parse only through
  `parseDocumentBody`. One pass only — do not re-parse the lines under a tag;
  that was tried, recursed and overflowed the stack on large documents.
- A tag is always written between blank lines. List and task items join their
  blocks with a single line break, so `serializeDocumentBody` stamps transient
  `tagLead`/`tagTrail` attrs on a copy (`withTagSpacing` in `imageTag.ts`) and
  the image renders the extra breaks; output without a tag-form image is
  unchanged. This matters because a hand-written block directly under a tag
  line, with no blank line, is read as text of the tag's paragraph (heading,
  list, quote, rule, table; a fence becomes inline code). The tool descriptions
  ask writers for the blank lines. `imageTagSpacing.test.ts` holds the
  neighbour × container round-trip matrix with the known list-item losses that
  exist for plain images too; `imageTagLimits.test.ts` pins the hand-written
  limitation and parse time at the size cap.
- Width from pasted HTML is taken only from an `<img>` carrying
  `data-weaver-src` (what `DocumentImage` renders), so copy/paste between
  documents keeps it and an image from another page gains none. Raw HTML other
  than the accepted tag still differs by runtime, as before: the server keeps it
  as literal text, while a browser parse (source view, assistant text, import
  preview) runs standard tags through the schema's DOM rules, where an `<img
src>` can become an image without width and unknown attributes are dropped.
- The width is applied as the `width` attribute in the editor NodeView, the
  reader (`DocumentImageMapping`) and the PDF (`pdf/html.ts`); the stylesheets
  keep `max-width: 100%; height: auto`, so it never overflows the column. Code
  that travels images works on the document tree (`collectImageSources`,
  `mapImageSources`, `rewriteOwnAssetsPrefix`, image references) and needs no
  tag handling; the one scan of Markdown text, the ZIP import preview
  (`zip-import.ts`), uses `imageTagSources`.

- Commit authors are the acting users, committers are `Weaver <weaver@local>`,
  and app commits carry `Weaver-User-Id: <uuid>`. Messages start with
  `create:`, `update:`, `move:`, `delete:`, or `restore:` and the resulting
  path. Change summaries are single-line, and attribution reads only the final
  canonical user-id trailer. Repository access stays behind
  `@weaver/git-store`.

## Invariants

- Math: formula sources bypass Markdown escaping because they are atoms, so a file
  stays plain LaTeX. Inline `$` must hug its content, and the first bare `$` after
  the opener closes the formula or the text is no formula; a closer before a digit
  or after a space fails it, so `$5 and $10 then $x$` reads only `$x$`. One line and
  at most 5,000 characters. `$$` on its own line(s), with no blank line inside, is a
  block; elsewhere it is an inline formula. A block leading a list item or in a table
  cell becomes inline, because the schema or one-line cell cannot hold it.
  `normalizeMathSource` repairs what saving formulas as text left behind: `\\` before a
  letter, `\_ \* \[ \] \~` and the backtick escape (not inside `\text{}`), `&lt;`
  and friends, and in inline formulas outside `\begin` a `\\` before a space. A real
  `a\\b` is misread, and escapes the old parser removed (`\{`, `\,`, `\%`) are gone until
  the file is imported again. `escapeMathInText` keeps literal text literal, per text
  node: `$a **b** c$` as marked text reads back as a formula, and a formula followed
  directly by a digit reads back as text. Marks do not apply to the atom, as for
  crossrefs. `validateDocumentContent` caps a source at `MAX_MATH_CHARS`. Render only through
  `renderMathHtml`, which turns a renderer failure into one error span; `maxSize` caps
  positive sizes only, so both stylesheets clip formulas to their wrapper.

- PDF export renders the saved revision only: `@tiptap/static-renderer` markup
  with `image` (data URI or "Image unavailable" box), `mermaid` (rendered in
  Chromium by the inlined bundle; a failing diagram prints its source) and
  `crossref` (current title, else stored label) mappings, A4 with page numbers,
  light theme. Limits: `MAX_MARKDOWN_CHARS`, 100 images or 64 MiB of image
  bytes (`413`), one render at a
  time per process with four waiting (`503` + `Retry-After`), `WEAVER_PDF_TIMEOUT_MS`
  (`504`), no Chromium (`503`). Failures emit `document.pdf.failed`.
  `mermaidBundleSource` reads the bundle by path from the app's `node_modules`
  (see `weaver-env-deploy`); only a production build shows a break there.

- A document archive (`createDocumentArchive`) pins one `HEAD` and holds
  `<slug>.md` plus everything under `<slug>.assets/` at the archive root, with
  no wrapper directory, under the folder archive's limits.
- ZIP import is reviewed in the browser and written per document.
  `importDocumentArchiveEntry` validates the folder path, sniffs every image
  the body references in the source `<file stem>.assets/` directory (at most
  100, each within `WEAVER_DOCUMENT_IMAGE_MAX_BYTES`; the route caps a
  request at 64 MiB of images and requires `content-length`), stores only
  referenced images under Weaver names, and inside one `withProjectRepo`
  section stages missing folders (`stageFolderInRepo`, sharing normal folder
  validation without an independent commit) and writes through `writeDocumentInRepo`. Images are
  validated before any folder is created. `create` gets a fresh id; `replace`
  re-reads the target under the lock, keeps its id, created stamp and folder,
  and removes assets the new body no longer references in the same commit.
  Collisions (same Weaver id, else same title in the target folder,
  case-insensitive) are found client-side in `zip-import.ts` against
  `folder.tree`; the server never guesses a replace target. The route has no
  upload rate limit: a folder ZIP sends one request per document, and the
  shared per-minute upload counter would stall it and block image uploads.
- Downloads read committed state only. The Markdown download is the blob
  `getDocument` resolved (its path and last-touching commit), unparsed and
  unchanged. A folder archive pins one `HEAD`, lists its blobs once, and holds
  every `.md` file and everything inside a `*.assets` directory beneath the
  folder, under one root directory named after the folder slug (the slugified
  project name for the root). Normalized `.folder.json` metadata travels too. `.gitkeep`, root `project.json`,
  `tables/**` and any other file stay out; a folder without archived files
  survives as an empty directory. A folder no committed file lies in is
  NOT_FOUND. Over `MAX_ARCHIVE_FILES` (10,000) or `MAX_ARCHIVE_BYTES` (1 GiB)
  the service throws `BAD_REQUEST` with `reason: "PAYLOAD_TOO_LARGE"` and the
  route answers `413`. Blobs are read by object id one at a time as the
  response is consumed; referenced icon bytes and normalized folder metadata are
  bounded by archive limits and held for the appearance closure. Do not switch to
  `git archive`: it applies committed `export-subst`/`export-ignore`
  attributes and fails on a pathspec without matches.

- The stock TipTap Markdown renderers do no escaping, so Weaver owns the
  encoding in `packages/core/src/editor/markdownEscapes.ts`. Code blocks and
  Mermaid use a fence longer than any backtick run. Inline code is fenced and
  padded through transient `fence`/`pad`/`segment` mark attrs that
  `serializeDocumentBody` stamps on a copy (never stored), and a code span is
  split wherever its other marks change. Image and link destinations, titles
  and alt text are CommonMark-escaped. The tiptap manager escapes `\` in every
  text node, so block and table escapes are post-render `renderMarkdown`
  overrides in `extensions.ts` with pure helpers in `markdownEscapes.ts`.
  `MarkdownParagraph` escapes a rendered line whose start would open a block
  on re-parse (`\#`, `\-`, `\+`, `1\.`, `1\)`, `\---`, `\>`; on lines after a
  hard break also any leading `#` and a setext `\=` underline). The manager
  entity-encodes `<`, `>` and `&` in text; `serializeDocumentBody` wraps its
  private `encodeTextForMarkdown` with `literalAngleBrackets`, which restores
  `>` and any `<` that cannot open a tag or autolink, except in URL-like words
  (a literal `>` would extend a GFM autolink). Documented
  normalizations: a paragraph's leading whitespace is trimmed to at most three
  spaces (no CommonMark escape exists for an indented-code start),
  whitespace-only paragraphs disappear, and list items and callouts trim edge
  whitespace. Table cells: `MarkdownTable` escapes every `|` of a rendered cell
  as `\|` (also inside code spans; the parser restores it), and
  `serializeDocumentBody` flattens a multi-block cell to one paragraph whose
  blocks are joined by `hardBreak`, rendered as `<br>`; the `HtmlLineBreak`
  inline tokenizer turns `<br>` back into a `hardBreak` on the server exactly
  like the browser DOM path (literal `<br>` typed as text is entity-encoded
  and survives). Merged table cells (colspan/rowspan > 1) are clamped to 1
  while parsing pasted HTML (`UnmergedTableCell`/`UnmergedTableHeader`;
  `fixTables` pads the rows), rejected by `validateDocumentContent` as a
  backstop, and the editor offers no merge/split actions. Callout markers
  parse case-insensitively and serialize uppercase; an unknown variant falls
  back to `NOTE`. Callout children are separated like top-level blocks
  (`>` line between them) and empty or whitespace-only child paragraphs
  serialize as `&nbsp;`;
  a callout with no body parses as one empty paragraph. Plain URLs and emails become links on parse (GFM autolink)
  and the serializer does not neutralize them — wanted for assistant/MCP text.
  A new node or mark needs a JSON → Markdown → JSON round-trip fixture with
  hostile punctuation in `markdown.test.ts`.
- All repository writes and their derived-index transaction stay inside one
  `withProjectRepo(projectId, ...)` critical section. Re-read mutable document
  rows after entering the lock.
- An image `src` saved into a document is either an `http(s)` absolute URL or a
  relative path (nonempty segments, `.` skipped, `..` allowed only while the
  resolved path stays inside the repository, no `\`, NUL or control characters,
  at most 255 bytes per segment and 2,048 characters total). Anything else,
  including `data:`, is `BAD_REQUEST`. The stored `src` is always the relative
  path; resolution to `/api/projects/<projectId>/files/<path>` happens only when
  producing DOM.
- Rename rewrites only `src` values starting with the document's own previous
  `<oldSlug>.assets/` prefix and moves the directory in the same commit; move
  carries the directory (re-slugging on collision and rewriting own links);
  delete removes it in the delete commit; restore rewrites the historic prefix
  to the current slug.
- `*.assets` directories are invisible to the folder tree, skipped by rebuild
  and projection repair, and reserved by slug allocation, so a stray
  `<slug>.assets` blocks that slug.
- Image serving reads committed blobs only, re-sniffs the bytes, and refuses
  non-images plus `.md`, root `project.json`, `.git/**`, and `tables/**`.

- Document API and content-operation schemas share `documents/title.ts`:
  trimmed, nonempty, at most 200 characters, and no line terminators or NUL. The core write
  tail and rebuild enforce the same stored-title invariant.
- `document.create`/`document.edit` content operations (MCP, proposals) drop a
  leading body heading that repeats the title (`withoutTitleHeading`), as the
  file import does; the web editor submits JSON and is unaffected.
- Create, update, and restore use one normalized internal write tail. Restore
  reads the selected version plus the current row/SHA inside one repository
  critical section, then commits once with `restore: <path> (from <shortsha>)`.
- Restore preserves the current document id/created time, advances updated,
  restores title/body, and uses normal collision-safe slug and rename handling.
- For document create/update/restore/move/delete, a successful Git commit is
  user-visible success. Log a post-commit projection failure and leave repair
  to `rebuildIndex`; never swallow validation, concurrency, or pre-commit
  failures. Folder moves and renames use the same post-commit contract and request project reconciliation after projection failure.
- `document.get` pins one immutable Git snapshot and reads the document blob
  plus its last-touching `baseCommitSha` from that committed state. If a
  concurrent rename makes the captured projection path absent, resolve the
  rename from the projected SHA to the pinned snapshot, verify the frontmatter
  id, and conditionally self-heal path/slug/SHA without acquiring the writer
  lock. A concurrent same-path update may return the pinned older version, but
  its content, cache key, and base SHA must stay coherent. A true missing or
  deleted id is NOT_FOUND. On save mismatch, allow only an identical-blob
  rename/move; otherwise return CONFLICT without touching the worktree.
- The parse cache stores one canonical tree per `(documentId, sha)` and returns
  a deep clone on every read, including the first parse result.
- Use `repo.commitDate(sha)` and the acting user's commit trailer identity for
  incremental `lastEditedAt` / `lastEditedById` projections.
- Serialized frontmatter plus Markdown must be at most 2,000,000 UTF-8 bytes.
  Use `services/documents.ts::assertDocumentFileSize` after composition and before
  writes; ordinary writes, recursive review preparation and single-document
  `documentReview.writeReview` share this guard. Reviewer writers pass the path
  for actionable errors. The input schema independently caps the raw editor JSON.
- Mermaid Markdown requires a distinct `mermaid` language token and matching
  fences; serialization chooses a fence longer than every source backtick run,
  and clipboard HTML restores source from its code element. Client rendering
  lazy-loads Mermaid and serializes the complete initialize+render operation,
  reasserting strict security, resolved theme, and suppressed library error DOM
  for every diagram; one local accessible component owns errors and late results
  are ignored.
- Slugs are unique per project. Auto-suffix collisions after consulting the
  index, worktree, and path history; never overwrite drift and never collide a
  title-only update against its own path/history.
- Move and delete re-read the document index row after entering the repository
  lock. Move commits `git mv` under that lock and re-slugs target collisions;
  delete retains inbound target-id link rows while the source relation cascades.
- Crossrefs have typed `document` or `table` targets and serialize as
  `weaver://document/<id>` or `weaver://table/<id>`; legacy nodes without a
  type remain documents. Resolve labels through the corresponding same-project
  `Document`/`DataTable` projection and preserve submitted fallback labels for
  unresolved or foreign targets.
- Keep `DocumentLink` rows exactly equal to every extracted typed target,
  including the empty set; `targetType` distinguishes document and table ids.
  Document backlinks must filter `targetType: "document"`; table backlinks
  validate current same-project table Git truth and filter `targetType: "table"`.
- Reference resolution accepts at most 25,000 ids in one request, returns typed
  same-project document/table rows, and masks foreign or unknown ids as
  metadata-free `exists: false`; tables use an empty excerpt for shape stability.
  The finite ceiling covers every valid 2 MB document.
  Browser queries use the configured POST-body batch-stream link and the route's
  paired method-override handler so the full input never depends on URL length.
  Backlinks first validate the same-project target and return project-scoped
  sources in a stable order;
  `apps/web/tests/integration/tableCrossrefs.spec.ts` is the focused mixed
  document/table regression contract.
- Routers remain thin; Viewer reads and Editor writes use service-layer project
  access assertions with nonmember/missing existence hiding.
- `document.update` accepts an optional `changeSummary`. Explicit comments are
  written into the commit. Omitted comments call `saveDocumentAndQueueSummary`:
  the normal save commits `update: <path>`, then a `pending`
  `DocumentChangeSummary` row (storing the pre-save path as `basePathAtSha`)
  and a `document.change-summary` job are created when jobs are enabled and
  `document_summary` is ready. The worker bounds the
  prompt, respects declared context limits (4,096 tokens when absent), leaves
  output room for reasoning models, and ends `ready`, `failed`, or `skipped`
  within three attempts. Commit messages are never rewritten; readers overlay
  the row. The normal save still owns access, validation, conflict detection,
  and Git truth.
- `writeDocumentInRepo` (`packages/core/src/services/documents.ts`) is exported
  so Phase 4D's `assistantProposals.ts` can commit an accepted document
  proposal through the same write tail as the router; its `WriteMetadata`
  takes an optional `operationId`, recorded as the commit's
  `Weaver-Operation-Id` trailer, and an optional `runId`, recorded as
  `Weaver-Run-Id`. Callers already holding the project lock via
  `withProjectRepo` (proposal acceptance included) must not call the
  service-level `getDocument` — it reopens its own repository view; read
  through the already-open `repo` handle instead.
  Create replay uses `repairDocumentProjectionInRepo` under that same lock to
  repair current/moved Git truth, links, and missing keyword readiness without
  resurrecting a deleted file. It shares rebuild's candidate validation and
  the normal write tail's projection transaction.
- A folder rename is `renameFolderInRepo` on every entrypoint, including the
  `folder_rename` content operation — never the move function, which keeps the
  name and only updates the `updated*` stamps. It lets `moveFolderToInRepo` write the new
  `.folder.json` after its validations (optional `displayName`), so a rejected
  rename leaves the worktree clean and a rename is one commit; a same-slug
  rename commits `update: <rel>/`, and an identical name is a no-op returning
  the current head.
- `moveDocumentInRepo` re-slugs when EITHER the target `.md` or its
  `<slug>.assets` directory exists: `git mv` of a directory onto an existing
  directory nests it, which breaks every image link.
- Folder and item lifecycle have lock-free `…InRepo` variants
  (`createFolderInRepo`, `moveFolderToInRepo`, `renameFolderInRepo`,
  `deleteFolderInRepo`,
  `moveDocumentInRepo`, `deleteDocumentInRepo`, `moveTableInRepo`,
  `deleteTableInRepo`) so `applyOperationInRepo` can commit them inside a lock
  the caller already holds. They carry no access check — the exported wrappers
  hold the `assertProjectRole(..., "Editor")` call — so any new caller must
  assert Editor itself before invoking one. The exported wrappers are thin
  `withProjectRepo` callers and keep their existing signatures; never call one
  from inside another project write lock.
- History uses offset paging over `git log --follow`, newest first. Read from
  HEAD through `offset + limit` and slice afterward so Git retains rename
  context; rename-aware version lookup checks reachability and reads one capped
  10,000-entry history window.
- Only commits recorded locally in `.git/weaver-trusted-commits` may resolve to a Weaver user; pulled commits retain external author text without matching users by trailer or email. Log fields use NUL framing.
- Validate and lowercase trailer UUIDs before a Prisma UUID query. Resolve a
  valid trailer to a User before consulting the commit author email; use email
  when the trailer is malformed, missing, or does not resolve.
- Rebuild opens an existing repository read-only, pins one `HEAD` SHA, scans
  its sorted Markdown files, and never initializes, recovers, resets, cleans,
  or commits. The existing-only callback holds the same per-project advisory lock as
  writers across the scan, attribution, and one project document/link
  repair transaction; an absent repository leaves the existing
  projection untouched. Before parsing a candidate, require canonical safe
  lowercase slug path segments, folder depth at most 10, a blob no larger than
  2,000,000 bytes, and a trimmed, nonempty, single-line title of at most 200
  characters; skip and report invalid external files without aborting valid
  rows.
- Rebuild and history share batched trailer-first/email-second attribution.
  Unknown authors stay null; malformed files, duplicate ids/slugs/paths, and
  ids owned by another project are skipped and reported without aborting valid
  rows.
- Diffs read Markdown bodies at each commit's rename-aware path, never include
  frontmatter, and run `diffLines` asynchronously with character, edit-length,
  and time bounds. Return `{ tooLarge: true }` when any bound is exceeded.
- List queries page/filter/sort server-side, accept `pageSize: 0` as All, and
  always include a stable id tiebreaker.
- `document.importFile` accepts `.md`/`.markdown`/`.py` only and refuses
  binary or control characters. A `.py` keeps its file stem as the title and
  drops a Weaver `# weaver` header (`splitPythonImport`); a ZIP entry may
  replace only a document of the same kind.
- Markdown imports strip a leading YAML frontmatter block or Weaver
  comment header before parsing the body (`splitImportHeader`); title
  precedence is frontmatter `title`, else a leading `# ` heading (which then
  leaves the body, as does one equal to the frontmatter title), else the file
  name, sanitized to the same `documents/title.ts` rules as every other
  document title. Input is capped at `MAX_MARKDOWN_CHARS` (200,000 characters);
  over that limit is `BAD_REQUEST`. Import creates the document directly
  through the normal `createDocument` write tail — no review or draft step —
  and does not import embedded images (ZIP import does).

## Recovery and rebuild

- `withProjectRepo` serializes writers per project. While holding that advisory lock,
  recovery requires `.git` to be a real directory, lstat/realpath-validates
  every traversed directory against that metadata root without following
  symlinks, removes real `.lock` files beneath it, then runs `git reset --hard
HEAD` + clean before writes. Atomic replacement prevents truncated worktree
  files, while `document.get` takes no writer lock and reads only its pinned
  committed blob. Do not bypass this wrapper or perform recovery concurrently.
- Worktree containment lives in git-store, not in services: `writeFileAtomic`,
  `writeBinaryFileAtomic`, `ensureFolder`, `mv` and `readFileFromWorktree`
  lstat-walk every existing path component from the real repository root and
  throw `WorktreePathError` on a symlinked component, `..`, an absolute path or
  `.git`. `fileExistsInWorktree` reports such a path as absent, so service
  gates answer NOT_FOUND. Never touch the worktree with `node:fs` directly.
- `rebuildIndex` is the repair path for projection drift. It opens only an
  existing repo, holds the project advisory lock while scanning one pinned
  `HEAD`, never
  changes Git, and repairs that project's projections transactionally. It
  preserves surviving document rows and their search chunks through scoped
  upserts, frees changed path/slug slots before restoring them, and deletes
  only absent IDs. Recreated rows invalidate keyword readiness so reconciliation
  reconstructs any cascaded chunks; malformed/conflicting files are reported.
- Any `.py` file in a project repository counts as a document for rebuild and
  folder review, as any `.md` always did: a foreign `.py` (no Weaver header,
  e.g. pulled from a remote) shows up as a rebuild skip and blocks folder
  review assignment for its folder.
- Project metadata sync resolves the actor first, then reads and composes live
  `project.json` metadata inside the repository lock; never capture the mirror
  before lock admission.
- **Recovery:** deleted content is Git-recoverable. The assistant/MCP
  `content_history` (mode=deleted) and `propose_content_restore`/
  `restore_content` tools (content tools slice 3, design §6) discover
  recoverable documents from committed `D` (delete) records in Git history —
  never from commit messages or trailers — so a document removed through the
  web UI is found too. Recovery preserves the original frontmatter UUID,
  refuses to overwrite a live document that already holds that id, and writes
  a new `restore:` commit rather than rewriting history. For manual recovery
  outside those tools: in the project repository, identify the deletion
  commit, restore the file from its parent while preserving the frontmatter
  id, commit the recovery, then run `document.rebuildIndex`. Work on a
  backup/branch first if the history is uncertain; never manufacture a
  projection row by hand.

## UI rules

The component map and layout description live in `docs/IMPLEMENTATION.md`.

- Creating a folder stays on the current level (`onFolderCreated` is a no-op in
  `ContentExplorerScreen`) so the new folder can be filled by drag and drop.
  Items and folders are draggable for Editors (`lib/explorer/drag.ts` payload, MIME
  `application/x-weaver-explorer-item`); folder rows/tiles and the Up button accept
  them and call the adapter's `useOperations` (existing document/table/folder move endpoints). Selected entries drag as a group; self/descendant folder targets are rejected. While an
  item is dragged inside a folder the Up button reads "Move up one level" with a
  dashed brand border (`itemDragging` in `ContentExplorerScreen`). The file
  import drop zone fills the canvas (`min-h-full`) and reacts only to `Files` drags.
  Dropped `.md` files import directly; each dropped `.zip` opens `ImportZipDialog`
  through `ExplorerImport.dialog`, one archive at a time, and nothing is written
  before the user confirms. Collisions default to Skip.
  An adapter with `itemDownload` also puts a `DownloadURL` payload on the drag
  (`setDragDownload`, effect `copyMove`, or `copy` for a Viewer), which
  Chromium browsers save as a file when the item is dropped outside the page;
  other browsers ignore it, so the menus carry the same download. Such an
  adapter makes items draggable and shows the action menus to Viewers, where
  they hold the download alone. Only the documents adapter offers downloads.
- Shared explorer selection/bulk behavior is owned by `weaver-ui-pages`:
  Ctrl/Cmd+click, Shift+click and keyboard selection plus Select all in the
  bulk actions bar; serial move/delete batches retain
  failures, and empty-only folder deletion remains enforced by the server.
  Bulk review previews filter eligible documents and capture their revisions;
  assigned Viewer reviewers can select/review while move/delete require Editor.
- Python documents (`DocumentScreen` → `PythonDocumentEditor`) have no toolbar
  and no Source toggle; Viewers get the read-only editor. PDF export and
  "Send to another Weaver" are disabled ("Not available for Python files"),
  the Contents tab lists definitions (`PythonOutlinePanel`), `DocumentDraftDialogs`
  is shared with the Markdown editor, and downloads are `<title>.py` as
  `text/x-python`. Icons come from `DocumentKindIcon` (explorer adapter
  `itemIcon(item)`).
- Folder state lives in the `?folder=` query, pushed on navigation
  (`parseFolderParam`/`folderHref`); search/sort/direction are local component
  state, reset by remounting the shared `ContentExplorerScreen` on a
  `key={folderPath}`.
- `DocumentScreen` owns document/diff; Editor+ receives a persistent TipTap
  canvas on every viewport and Viewer receives static `DocumentViewer`. There
  is no Edit/Done mode or global E shortcut. Do not focus the body/title on load.
- Preserve dirty edits when background access/document queries fail or membership
  changes. Disable focus refetch for editable documents; access loss locks the
  retained draft. Save/Discard appear only for changes or pending uploads.
  The shared query client does not retry access errors, so membership removal
  locks the draft when the first denied refresh returns.
- `useDocumentSession` compares the current title, raw text, and ProseMirror document with
  the acknowledged baseline. Save retains the editor and undo history; accepted
  discard/reload resets both content and history. Late refreshes must not replace
  newer drafts. Save failures retain changes; post-commit refresh failures report
  saved success. Scope reference/backlink invalidation to the project.
- `DocumentHistoryPanel` renders `changeSummaryMessage(message, changeSummary)`,
  a polite "Summarizing…" status while pending, and "Summary unavailable" on
  failure. Its first-page query polls while the newest pending entry is young: every 5 seconds under 2 minutes, every 30 seconds under 15 minutes, then stops (`changeSummaryRefetchInterval`); TanStack Query skips background tabs.
- Reconcile saved attribute/text normalization with minimal ProseMirror steps;
  whole-document `setContent` maps existing undo steps away even with
  `addToHistory: false`. Keep image paths reactive through `DocumentImageProvider`
  rather than recreating the editor after a rename/move.
- Image resizing lives in `DocumentImageNodeView`: a selected image in an
  editable editor shows two bottom-corner handles (`<button>`s, so the editor
  ignores their pointer events) and an "Image size" group with 25/50/75/100 %
  of the column and "Reset size". Dragging uses pointer capture, previews
  through an inline style and calls `updateAttributes` once on release
  (`clampImageWidth`: 48 px to the column width). Nothing renders when the
  editor is read-only, editing is disabled or the image is not selected.
- Pending image uploads count as unsaved work and block save. Map their captured
  selection bookmarks through transactions; cancel on discard, reload, unmount,
  or access loss so late results cannot enter another draft.
- `EditorToolbar` stays in the shared `DocumentsWorkspace` page header, left of
  Context. `DocumentWorkspaceToolbar` portals controls from the persistent editor
  into a stable header target; do not replace that target when Context collapses
  or the breakpoint changes. Groups share one fixed-height wrapping row
  (`useToolbarOverflow` + `visibleToolbarGroups`); groups that leave the first
  line collapse from the end into "More formatting options" (dropdowns become
  submenus) and stay mounted but `invisible`/`aria-hidden`/`inert`. A changed
  group list, a wider row, or a narrower group re-measures from the full,
  More-less row; never apply a stale visible count. Never add
  horizontal scrolling. Source remains fixed at the right. Every command runs
  through `runImmediate`; menu commands return focus to the editor without
  scrolling, modal-opening items leave focus to the dialog, items opening a
  non-modal layer (Reference) run only after the menu has closed
  (`after-close`), and dismissing a menu returns focus to its trigger. A menu
  whose trigger collapses or unmounts while open closes and focuses More (or
  the editor). Stateful menu triggers carry their state in the accessible name
  (`Text style: Paragraph`, `Callout: Warning`, `Code language: …`). Open menus count as transient UI; toolbar
  menu content carries `data-document-toolbar-menu` so Cmd/Ctrl+S still saves.
  Callout commands (`callout-commands.ts`) wrap every touched block (the whole
  list from inside a list item), change the surrounding callout's type, or
  unwrap it, each in one transaction; they refuse new callouts in table cells
  and selections crossing a callout boundary, but change the type from
  anywhere inside a callout (including its table cells or a selected callout
  node). There is no visibility toggle or Cmd/Ctrl+Alt+E shortcut. `[[` inserts references;
  `/` is ordinary text. Preserve mapped selections across forms and consult live
  editability before writes. Cmd/Ctrl+S saves, including from portaled toolbar
  controls through React event bubbling; Escape closes transient UI or blurs.
- `DocumentSourceView` is a bare, auto-growing textarea in the document body:
  no box, heading, helper copy, or extra buttons. Editor+ edits raw Markdown;
  Viewers see a read-only field. Source and Cmd/Ctrl+Alt+S toggle WYSIWYG/raw.
  Keep title, Save/Discard, and Context available. Both bodies stay mounted;
  hide/inert the inactive body and disable formatting/Mermaid commands in raw.
- Raw text, parse errors, and parsed content share the draft revision/baseline.
  `document-markdown.ts` bounds UTF-8 input and validates the parsed schema.
  Preserve literal text while typing/toggling; canonicalize on successful Save
  while preserving the focused raw field's selection.
  Invalid raw stays dirty and blocks Save/return to formatted mode; show the
  validation error on that attempted action. Do not replace a lexical-only draft
  with background refreshes. Raw semantic edits enter ProseMirror history;
  discard/reload reset both editor history and the native textarea history.
- Raw typing is temporarily read-only during pending uploads, using the existing
  Uploading status. Keep editor editability session-owned so late uploads finish
  and update source without racing a raw text edit.
- `use-document-source-view.ts` owns mode, saved focus, and workspace scroll.
  Opening focuses its noneditable region without activating the phone keyboard;
  returning restores the formatted position and focus. A new canonical section
  navigation key reveals the formatted body synchronously once raw input is valid,
  without restoring the previous location. Saves must not force a view switch.
- View shortcuts are page-scoped in `use-document-view-shortcuts.ts`; ignore IME,
  AltGraph, repeats, overlays, and unrelated fields. Source fields explicitly
  accept Cmd/Ctrl+Alt+S and Cmd/Ctrl+S; unmodified Escape blurs the source textarea
  without changing mode or discarding changes.
- Validate submitted JSON with the shared ProseMirror schema before serialization.
  The shared inline-code extension permits other marks so Markdown emphasis and
  links around code survive import, validation, and editor round trips.
  Top-level headings consume canonical indexed anchors; nested/empty headings
  receive fallback anchors without shifting indexed anchors. The editor uses
  decorations for anchors and ephemeral highlights, never stored heading attributes
  or dirty transactions. Do not add highlight attributes directly to editor DOM;
  ProseMirror can remove them on redraw. Section
  navigation focuses the noneditable title anchor for Editor+ to avoid opening
  the phone keyboard, and does not replay on save.
- Live crossref previews reuse `DocumentReference` through `DocumentCrossref` and
  `DocumentReferenceProvider`. Resolution updates must not rewrite node attributes
  or fallback labels; client-only extensions keep core Markdown/JSON unchanged.
- Keep `.document-prose > div`, full-width reader/editor bodies, and wrapped code
  blocks. Retain the existing history navigation guard and explicit conflict reload.
- Memoize `listFolderEntries`/`searchFolderEntries`/`sortEntries` results
  (`lib/explorer/entries.ts`, pure functions shared with tables) on the tree
  query data plus folder path, search, sort, and direction.
- The list/icons view choice persists to the adapter's `viewStorageKey`
  (`weaver-documents-view` for documents, `weaver-tables-view` for tables)
  `localStorage` key, restored only after mount (avoid a hydration mismatch),
  and survives a reload. The shared `ContentExplorer` owns keyboard browsing
  through `lib/documents/use-roving-focus.ts`: arrow keys move focus, Home/End
  jump to the ends, Enter opens the focused entry, and Backspace/Alt+Up call
  `onNavigateUp` — there is no tree to expand or collapse.
- The Contents tab is the rail's first and default tab (a `?version=` link opens
  History). It lists top-level headings with text, exactly the canonical
  outline; nested and empty headings keep fallback anchors but stay out of it.
  Editors see the live outline from `documentOutlineFromState`, which returns
  the same array until a heading's anchor, level, or text changes — never
  serialize the document per transaction for it. A click sets a
  `DocumentSectionNavigation` with an incrementing `jump` in `DocumentScreen`
  (it yields to a new `?section=` link), so repeating a jump scrolls again and
  the URL stays unchanged. Jumps scroll to `block: "start"`; the editor
  publishes its sticky title height as `--document-sticky-header-h`, which the
  section `scroll-margin-top` and the scroll-spy reading line both use. Deep
  links keep `center`. In the phone drawer a jump closes the drawer with
  `requestSelectionCloseFocus` so the trigger does not take focus back.
- The expanded `ContextRail` (and `TableContextRail`) shows a desktop-only
  `PanelResizeHandle` on its left edge; the shared width is `--context-rail-w`
  (see `weaver-ui-pages`), which the header's Context controls also use.
- `DocumentsWorkspace` owns the Context toggle beside the header toolbar.
  Collapsing removes the right `ContextRail.tsx` column while its tab contents stay
  mounted. Keep header controls outside the scrolling canvas. The mobile Context
  drawer always shows tabs; responsive focus handoff includes desktop header
  controls as well as the rail content.
- Viewer keeps read/history/diff and Explore graph; Editor+ edits on desktop and
  phone. Maintainer+ sees index repair. Check capabilities as well as membership.
- Code blocks carry a copy button (`_components/DocumentCodeBlock.tsx`): the
  reader adds it through `documentCodeBlockMapping`, the editor through
  `CodeBlockWithCopy`, a client-only node view passed as the `codeBlock` override
  of `documentExtensions`. The button is `contentEditable={false}`, prevents
  mouse-down so the selection stays, and reads `node.textContent` on click; it
  must never change the schema, stored JSON or Markdown. PDF, source view,
  assistant text and the import preview have no button.
- Keep strict serialized Mermaid rendering and visible accessible local errors.
  Mermaid source is closed initially and edited locally beside the preview;
  source controls obey live editability and pending-save locks.

## Patching

`document.patch` (`propose_document_patch`/`patch_document`,
`packages/core/src/documents/patch.ts`) changes a document by exact text or by
section instead of resubmitting the whole body.

- Selectors (`find`, `anchor`) resolve against the canonical Markdown
  `getDocumentAtSnapshot` returns, never the raw file body — the model reads
  and edits the same text.
- Section ids come from `navigate_document`'s outline
  (`packages/core/src/documents/outline.ts`) and are scoped to the revision
  they were read at; a stale id is `NOT_FOUND`/unknown rather than a guessed
  offset.
- Actions compile to non-overlapping ranges of the original body and apply
  from the end backwards, so no action may depend on text another action in
  the same patch inserted.
- Ambiguity — zero or multiple matches for a selector, an unknown section id,
  or two actions touching the same range — is a structured `AMBIGUOUS_MATCH`
  error, never a best-effort guess.

## Testing

Run `pnpm test:integration:documents` for the documents area (it includes
`documentImages.spec.ts`), or the focused `documents.spec.ts`,
`documentHistory.spec.ts`, `folders.spec.ts`, `documentImages.spec.ts`, and
`documentDownload.spec.ts` and `documentArchiveImport.spec.ts` through
`pnpm test:integration`. The archive
selection, ZIP writer and `archiveFolderInRepo` also have unit tests that run
against a temporary Git repository without a database. Automatic save comments use
`documentSummaries.spec.ts`; routing uses `llm.spec.ts`. Typed table references use
`tableCrossrefs.spec.ts`. Pure draft/upload/editor/render/navigation helpers have
colocated unit tests; these do not prove browser focus or layout.
UI changes require `pnpm check`. Browser specs are `documents.spec.ts`,
`tables.spec.ts`, and `knowledge-ui.spec.ts` under `apps/web/tests/e2e/`;
`document-helpers.ts` uses direct save and `expectDocumentToolbar`; toolbar
commands go through `runToolbarCommand`/`toolbarControl`, which fall back to
the More menu at phone width. Browser coverage
also checks header placement and persistence while scrolling/toggling Context,
raw editing/round trips, and focus/selection preservation.
Run only through `pnpm e2e` with Tier 3 consent. See `weaver-testing` for the
three-database guard and test cadence.

## Remote pushes and pulls

Project Owners configure a single SSH remote in Project Settings through
`services/projectGitRemote.ts`. The `git` worker role pushes existing committed
history (including root `project.json`) without a new export format. Content
writers need no enqueue hook: `notifyProjectContentChanged` (best-effort, never
throws) dispatches a due push immediately after every content commit — saving
the remote, uploading a key, or a manual push does the same — and minute
discovery remains the fallback for anything a dispatch misses.
`packages/git-store/src/remote.ts` captures under the shared read lock and releases
it before networking; never hold the content mutation lock over a remote push.
See `weaver-jobs` for durable claims/retries and `weaver-env-deploy` for OpenSSH
and encryption setup. Credential metadata is separate from Git content.

Owners can also pull the remote branch's existing content in
(`services/projectGitRemoteMerge.ts`, `mergeFetchedBranch`, queued as
`project.git-pull`). Invariants:

- Never hold the project repository lock over networking: `fetchRemoteBranch`
  fetches into a temporary bare repository outside the lock; only the local
  `fetchLocalRef` → merge → commit sequence runs inside `withExistingProjectRepo`.
- Compare local and remote content against their merge base. Adopt remote-only edits,
  deletions and renames; preserve local-only changes. Divergent edits to the same
  identity preserve the remote original and re-slug the local conflict copy with a
  fresh id, including its assets or full table directory. Different-id path
  collisions retain the collision-safe local copy. A fast-forward adopts the remote
  snapshot. A changed divergent pull disables automatic pushes and advances the
  configuration revision; an Owner must explicitly re-enable after review. Serialize
  merge/outcome with the remote-settings advisory lock, without taking a Project
  row write lock before the repo lock (document projection writes need its FK lock).
- A fetched branch whose tree holds a symlink (`120000`) or gitlink (`160000`)
  entry is rejected with `UNSUPPORTED_REMOTE_CONTENT` before any worktree reset
  (`repo.listTreeEntries`); the worktree containment check is the backstop for
  repositories that pulled such content earlier.
- Phase A reads each tree through one batched `repo.readBlobsAt`, never one
  `git show` per file: that scan runs under the exclusive lock inside the
  pull's lease. `readBlobsAt` streams `git cat-file --batch` chunk by chunk:
  over-limit and non-blob payloads are drained without buffering, only kept
  blobs (≤ maxBytes) are assembled, and the process has a 60-second timeout.
- Re-slug targets are unique project-wide by slug, not just by path: phase A
  skips any candidate whose slug is already held by a document (or `.table`
  directory) in any folder of either tree, was claimed earlier in the same
  run, or exists as a `{projectId, slug}` row, because rebuild drops duplicate
  slugs. Still open: two unrelated items with the same slug at different paths
  and no path collision are not re-slugged; rebuild keeps only one.
- `refs/weaver/pull` is transient: it exists only to fetch the remote branch
  locally for the merge and is deleted in a `finally`, on success and on any
  failure, before the lock is released.
- Push and pull share one lease per `ProjectGitRemote` row; a follow-up push
  after a pull is dispatched only after the pull's own lease release completes.

## Sending to another Weaver instance

"Send to another Weaver…" (`SendToRemoteDialog`, opened from the document
actions menu) sends the saved revision, never unsaved draft edits, through
`remoteInstance.sendDocument` → `sendDocumentToRemote`
(`packages/core/src/services/remoteInstances/transfer.ts`). It rewrites
crossref nodes to their plain-text titles (`crossrefsToText`) before
serializing, and collects only images under the document's own assets
directory at that revision, capped at 100 images and 46 MiB combined. The
receiving instance writes it as a fresh document with no history, attributed
to the receiving user, and sets the commit trailer `Weaver-Operation-Id:
remote-transfer:<sending instance base URL>` — this is the one document-only
exception to the trailer's usual `mcp:…`/proposal meaning. See `weaver-auth`
for the peer OAuth client and `weaver-admin` for the registry.

## Content validation and destructive concurrency

`validateDocumentContent` bounds JSON before ProseMirror construction: 2 MB,
100 levels of JSON nesting and 25,000 typed nodes. Crossrefs require canonical
lowercase UUIDs and valid target/label attributes. Serializer failures are
BAD_REQUEST. Restore requires the viewed `expectedHeadCommitSha` and compares
it under the Git lock. Git commits strip ASCII controls from caller message
and author fields; local Git subprocesses have a 60-second timeout. Remote
settings display the persisted host-key SHA256 fingerprint separately from
the uploaded deployment-key fingerprint.

Document backlinks return `{ documents, nextCursor }`, ordered by title then ID,
with 50 records by default and a maximum of 100. Cursors resolve only inside the
same project and target backlink set; stale/foreign cursors fail BAD_REQUEST.
`DocumentLinksPanel` uses an infinite query with an explicit Load more control.

## Review hardening (September 2026)

Active advisory-lock clients listen for connection loss and abort Git subprocesses;
commit and ref publication recheck the session. Recovery refuses fresh lock files.
Repository-local attributes disable remote text/filter transformations, writes
force-stage ignored files, and recovery cleans ignored leftovers. Restore and diff
check historical document identity; history offsets are capped at 1,000 and pinned
path lookups are cached. Projection failures request reconciliation.
Image requests compare authorized blob ETags before loading bytes and emit RFC 5987
filenames. SSH keys are removed immediately after network commands, and worker
startup sweeps temporary remote directories older than one day owned by its UID.

## Atomic appearance services

`services/contentAppearance.ts` owns `appearance.get`/`set`: Viewer reads,
Editor writes, with access and item revisions rechecked under the project Git
lock (scoped folders guard project HEAD; the nameless document root is rejected).
Writes preserve document content, authorship timestamps and review clocks.
Omitted patch fields preserve values; null resets only the selected field.
Clearing an icon retains bytes referenced by another item or an older revision.
`documentMetadataColumns` projects appearance, and rebuild/list/tree reads keep
it normalized. Content saves/restore preserve current appearance; deleted
recovery retains recovered appearance. Folder rename/move carries appearance.
Trees expose `folderAppearances`, keyed by the scope-relative path, from the
same captured revision as folder names/stamps. The document root has no key
and cannot be styled; a styled tables root uses key `""` and
`tables/.folder.json`, without introducing a visible folder entry.

PNG/JPEG/WebP icons are at most 2 MiB and live at
`.weaver-icons/<sha256>.<png|jpg|webp>`. Upload bytes and metadata share one
commit. Pre-commit failures restore captured originals and call Git-store
`resetWorktreeTo(head)`, then `removeUntrackedFile` only for newly introduced
files absent at captured HEAD. That primitive checks repository containment
and refuses tracked/symlink/traversal targets; never remove shared assets or
swallow rollback failure. Post-commit projection failure keeps committed Git
truth and follows the existing repair/logging path. The reserved icon root is
excluded from folder/document/recovery discovery and ordinary file serving.
`services/appearanceAssets.ts` serves only committed digest/type-validated icons
through `/api/projects/[projectId]/icons/[filename]`; membership is rechecked
before ETag/304. The appearance multipart route authorizes the URL's project
before reading bytes and accepts exactly `target` JSON, `expectedRevision`,
`patch` JSON and one `file`; it bounds the stream to 2 MiB plus 64 KiB overhead.

## Appearance portability

`appearanceAssets.collectAppearanceAssetsAt(repo, revision, appearances)` reads and
deduplicates only committed referenced icons. ZIP folder wrappers rebase content,
while `.weaver-icons/<digest>.<extension>` remains at archive root. Archive limits
include metadata and icon bytes before collection. Browser ZIP reads reject
sanitized traversal, noncanonical reserved paths, oversized entries and invalid
image digests; folder metadata is normalized before upload.

The existing document-import multipart route also accepts optional `folderMetadata`
(target slug path to normalized metadata) and repeated `icon` file parts named
`<digest>.<png|jpg|webp>`. `mode=folders` requires nonempty folder metadata, no Markdown
or document-image parts, and permits only icons referenced by those folders.
Old create/replace forms remain valid. New folders take imported names/appearance
and current actor stamps; existing folders are never overwritten. `ensureFolders`
uses the shared `folders.stageFolderInRepo` validation/staging owner. Document
imports and folder-only imports each publish one commit including their icon
closure, with rollback covering metadata, `.gitkeep`, content and new icons.
ZIP Replace retains destination appearance and imports no source appearance icons.
Plain Markdown preserves appearance text and returns optional `warnings` for a
missing icon (shown by the explorer import UI); its built-in fallback remains usable.

`createDocument` accepts optional appearance and validated `iconAssets`; its existing
locked create pipeline uses `withAppearanceAssetsInRepo`, as do archive imports.
If a create/import callback fails after HEAD advances, this wrapper preserves
accepted content and icons; only failures before commit roll back touched files.
Remote documents/tables accept optional appearance and base64 `iconAssets`, validate
hash/type/2 MiB bounds before creation, and include icons in existing transfer caps.
Image sends require `whoami.capabilities.contentAppearance=1` before content POST;
text-only legacy transfers remain valid. Errors contain no icon bytes.

Project machine writes use a separate content author (`services/contentAuthor.ts`); they never gain membership. Preserve the machine editor pair (`lastEditedByMachineKind`/`Id`, dual-writing `lastEditedByProjectKeyId` this release) and captured name when rebuilding, and clear the prior machine stamp on human edits/moves. Machine publishing flows through `projectApi/operations.ts` with operation→project locks and revision/idempotency guards. Operation locking has its own `WEAVER_PROJECT_API_OPERATION_LOCK_POOL_MAX` (1–128, default 2) so single-connection repository/application pools remain safe.

## Review hardening invariants

ZIP exports validate file, directory and wrapper paths at emission. ZIP Replace requires the collision preview revision under the repo lock. Historical restore copies referenced own-image blobs within image/count/aggregate limits. Create recovery inspects all changed canonical paths and verifies the operation-derived document ID.
