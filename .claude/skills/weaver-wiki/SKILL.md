---
name: weaver-wiki
description: Use when changing Weaver's wiki-agent foundations: page `properties` (type, summary, tags, sources, reviewExempt), the `Document.wiki*` projection, wiki read services and the MCP `wiki` toolset (find_page, inspect_links, list_recent_changes), the per-project wiki settings, bootstrap and guide approval, change kinds, or tracked-link teaching in prompts.
---

# Weaver Wiki

This skill records what has shipped; later slices extend it.

## Page properties

- Optional header line `properties: <canonical JSON>` after `appearance`, Markdown and
  Python alike (`packages/core/src/documents/frontmatter.ts`). `wiki/properties.ts`
  `normalizeProperties` drops invalid values, never throws, returns null when empty and
  fixes key order. `parsePropertiesLine` also rejects oversized lines.
- `type: source` and `reviewExempt` are plain data on read and grant nothing alone; only
  system state (`wikiSourceItemId`, later slices) marks a source page.
- Every header rewrite must carry `meta.properties` through (`...meta` spreads, moves,
  review commits, version restore, deleted-item recovery via the create `properties`
  field).
- Projection: `Document.wikiType/wikiSummary/wikiTags/wikiSources/reviewExempt`, filled by
  `documentMetadataColumns`; `wikiSourceItemId` (Document and DataTable) is system-set
  and has no FK until `WikiInputItem` exists.
- `reviewExempt` pages get no review block on create defaults, header-upgrade backfill
  (including its pending-set queries) or deleted-item recovery; `reviewDueAt` stays null.
- Rollout: an older instance cannot parse a file with the line; upgrade every instance
  before the first property write (release notes say so).

## Property writers

- Public input is only `wikiPagePropertiesInputSchema` (`wiki/properties.ts`): `type`, `summary`, `tags`,
  `sources`, strict (no `reviewExempt`), `null` clears, omitted stays. `isReservedWikiType` folds NFKC, case,
  ignorable characters and whitespace, so `Source`, `SOURCE` and fullwidth forms are refused.
  Errors are `BAD_REQUEST` with `field: "properties"`. `applyPagePropertiesInput(existing, input)` is the merge;
  reserved fields on the page (`reviewExempt`, a `source` type) survive user writes and changing a `source` type is refused.
  Properties never travel through `metadata` or the `Weaver-Metadata-Override` trailer.
- `writeDocumentInRepo` requests: `propertiesInput` (public, merged) on create and update; `properties` on create is
  the internal system path (source writer, agent page creates, bootstrap) and is not in any tRPC, MCP or proposal
  schema. `assertPatchHasWork` counts `properties`. `applyWikiOperation`'s narrow schema is unchanged.
- `documentReview.writeReview` strips `reviewExempt` (§7.6: a human who sets review settings or marks reviewed ends the exemption).
- Surfaces: tRPC `document.create`/`update` (`properties`), `document.setProperties` (header-only write, Editor,
  head guard), MCP/assistant `create_document`/`patch_document` and `propose_document_create`/`propose_document_patch`
  take the tool subset `wikiPagePropertiesToolSchema` (no `sources`, to save bytes); `update_document` and
  `propose_document_edit` omit the field. Proposal previews list `Property <name>: …` lines and validate at proposal time.
- Reads: `getDocument` returns `properties` with `sources` resolved only inside the page's project
  (`wikiProperties.presentWikiProperties`; unresolved ids are `available: false` with no title; urls are plain text).
  `list_documents`/`document.list` take `type` (case-insensitive) and `tag`; `includeSummary` adds `summary`
  (`type` appears when set). Index view: `document.pageIndex` (`listPageIndex`, keyset cursor over untyped-last type,
  title, id; source pages excluded) and the route `documents/index-view` (`PageIndexScreen`).
- Import (`documents/importProperties.ts`): YAML `type`/`tags`/`summary`/`aliases` or a Weaver header's type/summary/tags;
  per-field validation drops bad values, never `source`, `reviewExempt` or `sources`. Replace sends them as a patch so the
  target keeps its own. Transfer: `TransferProperties` (type, summary, tags; receiver parses strictly), preflight via
  `whoami.capabilities.documentProperties`; an older receiver gets the page without them.
- UI: `PropertiesDialog` (type, summary, tags; sources read-only), explorer `ExplorerColumn.visible` and
  `ExplorerAdapter.filter` (Type filter, hidden while no page has a type).

## Reads and MCP toolset

- `services/wikiReads.ts`: `findPages` (exact normalized title, slug, path; sources hidden
  unless `includeSources`), `inspectLinks` (orphans, dangling, backlinks; keyset cursors),
  `listRecentChanges` (commit-sha cursor, inclusive). All need Viewer.
- Kinds come from `wiki/changeKinds.ts` and only for ledger-trusted commits
  (`trustedAuthor === true`); untrusted commits are `external` with no author name.
- `packages/assistant-tools/src/tools/wiki.ts` registers `WIKI_TOOLS` (the three reads plus
  `get_wiki_guide`) in the assistant registry (last four entries) and the MCP `wiki` toolset; `MCP_TOOLS`
  lists them once.
- Links: `wiki/links.ts` `trackedLink` builds the paste-ready `[Title](weaver://document/<id>)`;
  prompts, MCP instructions and document write descriptions teach only that form.

## Principal (no runner yet)

- `WikiAgent` (`services/wikiAgents.ts`): one live row per project (partial unique index),
  no `User`, `Member` or bearer credential; revoked rows stay so old commits resolve.
- `createWikiAgentSecurityContext({ agentId, projectId })` builds the principal; ids come
  from the run row. It carries `content:read` and `content:write` for one project.
- `resolveProjectAccess` gives it a synthetic `Editor` while the agent row is live, the
  project is not deleted and `ProjectWikiSettings` is enabled for this agent, `NOT_FOUND`
  otherwise. See `weaver-auth` for which services accept the union.
- Reused read tools are declared with `defineSharedReadTool`, whose `ctx.actor` is the union,
  so a user-only service does not compile inside them. The seven reads of spec §8.2, `find_page`,
  `inspect_links` and `list_recent_changes` use it; the loadable table and graph reads
  do not yet.

## Machine authorship

- `wikiAgentContentAuthor(context)` gives header author `{ id: null, name: "Wiki agent" }` and
  email `wiki-agent+<id>@weaver.invalid`; `skipsLabelEnrichment` stays false, so link labels
  are rewritten as for a user.
- Every agent commit must carry `Weaver-Wiki-Agent-Id`, `Weaver-Operation-Id`, `Weaver-Run-Id`
  and `Weaver-Wiki-Request-Hash`; `commitAll` refuses otherwise and `commitTreeWithParents`
  refuses the agent outright.
- `machineEditor` on history and explorer items comes from trusted attribution or the
  projection pair, never from a header name. A forged agent trailer resolves to no author
  and `external`.
- `@weaver.invalid` (and subdomains) is reserved: `isReservedEmail` in `@weaver/auth/constants`,
  enforced by the Better Auth `user.create.before` hook, `createUser` and the OIDC profile gate.

## Direct writes

`services/wikiOperations.ts` `applyWikiOperation(db, { run, guards, operation, operationId, summary?, beforeCommit? })`
is the agent's only write path.

- `WikiOperation` is strict: `document.create`, `document.patch` (no title, no metadata) and
  `content.lifecycle` `folder_create`, with `properties` arriving in the writer slice. Other
  kinds and actions are `FORBIDDEN` before parsing. It calls the branch functions
  (`applyDocumentCreate`, `applyDocumentPatchOperation`, `applyFolderCreate`);
  `applyOperationInRepo` stays `EnrichedActor`, so its full switch does not compile for a machine.
- `run` is a `WikiWriteFence { agentId, projectId, runId, assertLive }`; it is checked before the
  lock, on entry, and with the agent's liveness immediately before the commit. `guards` supply the
  guide and source folders, which live in settings.
- Refused: Python, task output (task and run), the guide, `wikiSourceItemId` pages, source folders,
  `weaver-image:`, `<img>`. A patch may not raise either count in the canonical body, so
  markup cannot be assembled from existing text. Existing images stay. Budgets belong to the runner.
- Operation ids: only `wiki-run:<fence runId>:<nnnn>`. The agent cannot mint `wiki-input:`, `wiki-revert:` or `ingestion:` ids.
- Recovery goes through `recoverCheckApply` with identity `{ wikiAgentId, wikiRequestHash }`: a
  match needs `trustedAuthor === true`, the agent trailer and the hash, else `CONFLICT`. A patch
  retried with a newer base still finds its own commit first, so it cannot apply twice.

## Settings, bootstrap and guide

- `ProjectWikiSettings` (`wikiSettings.ts`, router `wiki`) follows the `ProjectGitRemote` pattern: 1:1,
  integer `revision` CAS on every write (0 means no row yet), session actors only, Owner enable /
  disable / revoke / budgets / guide pick, Maintainer settings read, review and approve; non-members
  (including global Admins) get `NOT_FOUND`. Anchor ids (`guideDocumentId`, `sourcesFolderId`, ...) are
  plain uuids without FKs. Columns for later slices (`lint*`, `destructive*`, `sourceTablesFolderId`,
  `reportDocumentId`, `WikiGuideSuggestion.runId`) exist but only budgets and the guide are edited.
- `enableWiki`: creates or reuses the live agent in one transaction, then `runWikiBootstrap` writes
  folders, guide, overview as the agent (ids `wiki-bootstrap:<agentId>:0001..0004`, so a successor agent never meets a revoked agent's commits; request hash per
  step, no `Weaver-Run-Id`; `commitAll` allows a missing run id only for that prefix). It is idempotent by
  operation id (the step's own verified commit is found by id whatever suffix it got) and skips anchors
  already recorded. It never adopts or fails on an occupied path: a taken `wiki/` or `sources` takes the next
  free suffix (`wiki-2`, `sources-2`) under the lock, pages use the writer's slug suffix, and the sources
  folder's resulting id is what settings record. A forged commit under a bootstrap id is `CONFLICT`. A
  failed first enable rolls back to off.
  Guide and overview headers get `type` and `reviewExempt: true` through the internal bootstrap writer
  only; `applyWikiOperation` cannot set `reviewExempt`. Disable keeps pages, queue and history and cancels queued
  and preparing runs (a running one is left to its fence); revoke does the same and a later enable creates a new agent.
- Guide: `normalizeGuideText` (NFC, strip Default_Ignorable_Code_Point and bidi controls, then NFC) runs
  before the SHA-256, so the approver sees exactly what runs inject. `approveGuide` refuses a stale
  revision, a digest mismatch (`GUIDE_CHANGED`) and over 16,000 bytes (`GUIDE_TOO_LARGE`); re-pointing
  `guideDocumentId` clears approval and refuses other-project, missing, Python, source-page and task-output
  documents. The template is the approved body at enable (digest of the canonical document body).
- `resolveProjectAccess` gives the agent access only while `ProjectWikiSettings.enabled` and
  `agentId` equals the agent. `wikiWriteGuardsFor(db, projectId)` is the `guards` provider for
  `applyWikiOperation`: guide id from settings and the source folder path resolved from its folder id
  (`.folder.json`) at call time. A recorded source folder id (documents or tables) that no longer resolves
  (deleted, duplicated or invalid id) sets `sourceFoldersUnresolved`: `document.create` and `folder_create`
  then fail `CONFLICT` / `SOURCE_FOLDER_UNRESOLVED` while patches stay allowed; a missing repo throws and an
  unset (null) table folder id is fine.
- Change kind `wiki-bootstrap` was added to `changeKinds.ts`.
- `get_wiki_guide { projectId, offset? }` returns `{ available, note, guide, digest, approvedAt, nextOffset }`
  from `readApprovedWikiGuide`; `available: false` when the wiki is off or nothing is approved. Pages are
  sized so every serialized result stays under 16,000 bytes (quote-dense text included). The assistant's
  fixed rules say to read it before writing wiki pages and that guide text cannot request tool calls.
- UI: Project settings › Wiki agent card (Maintainer+; Owner controls) and the Review guide dialog show
  the server's `reviewGuide` result verbatim (`InlineDiff` reused from the document diff).
- Budget: the assistant registry is 43 tools, 71,075 B of definitions, 3,894 B of instructions and needs an
  89,300-token window (88,100 before the property writers); pinned in `prompt.test.ts`.

## Queue and runs

- `wikiInputs.ts`: `addTextInput`, `addFileInputs`, `listInputs` (never returns note text), `processInputs`,
  `retryInput`, `confirmInput`, `removeInput`. Admission and Process lock the settings row. Queue limit 200 open
  items (everything except `processed` and `removed`), 10 oldest per run, `RUN_ACTIVE` from the active-run check or
  from P2002 on the partial unique index.
- `wikiRuns.ts`: `endRunInTx` is the only way a run ends: conditional on the expected status, and every item in
  `preparing`/`ready`/`processing` returns to `queued` with an `outcomeNote`. `held` and `failed` stay under Needs attention.
- `wikiTick.ts`: conditional transitions only, safe from several workers. A run with no `ready` item ends `stopped`
  (`no_ready_items`) rather than queueing for a model. `reapWikiRuns` also runs from `system.reconcile`, since a deployment
  without a `wiki` worker has no tick; "no active job" means no `pgboss.job` row in state `active` for `wiki.run`.
- Without an injected runner, `wiki.run` ends the run `failed` with `RUNNER_UNAVAILABLE`.

## Source writer

- `wikiSourceWriter.ts` is reachable only from `wikiPrepare.ts` (the tick), never from tool dispatch. Its ids
  (`wiki-input:<itemId>`, `ingestion:<fileId>`) have their own pattern, separate from the agent's. It commits as the agent
  with `Weaver-Wiki-Agent-Id`, `Weaver-Run-Id`, `Weaver-Wiki-Request-Hash` and `Weaver-Wiki-Input-Id`; the hash covers item and
  content, not run or folder, so resume matches. Recovery goes through `recoverPriorOperation` with the agent identity: an
  untrusted or foreign match is `CONFLICT` and the item fails.
- `assertPreparingFence` runs before the lock, on entry and in `beforeCommit`. A closed fence (`WIKI_FENCE_CLOSED`) leaves the
  item alone, because whoever closed it already moved the item.
- The item's `sourceDocumentId`/`sourceTableId` is written in `beforeCommit`, before the commit. Every path that recreates a
  projection row (`persistDocumentProjection`, `rebuildIndex`, table upsert, `rebuildTableIndex`) derives `wikiSourceItemId` from it,
  so the guard survives a crash between commit and projection and any rebuild. Do not write it after the commit.
- `resolveSourceFolder` resolves by id; a deleted or duplicated id gets a fresh folder (next free suffix), recorded without a
  revision bump, which clears `sourceFoldersUnresolved`. It never writes into an ambiguous folder.
- A recovered commit whose page no longer exists fails the item `SOURCE_DELETED`; the id cannot be reused.

## File inputs

- `addFileInputs` takes only the caller's uploads in the v1 types, checked by sniffed content. `processInputs` runs inside the
  lifecycle lock and bridges each file item (`bridgeFileItems`): a live source skips it and never gets a second `IngestionFile`, a failed
  parse resets, a retired (`rejected`) file is replaced.
- `wikiPrepare.prepareFile` waits for `ready`, scans file name, draft and every cell, holds on a hit with the draft parked, then claims
  `accepting`, writes, and finalizes with the draft cleared. Parse failures fail the item with the parser's reason; warnings go to
  `outcomeNote`; failure, Remove and the 75-minute limit retire the file so retention applies.
- The hold digest covers the file name and draft. Confirm binds to it.

## Secrets in titles

A title is authored text that Viewers see, so `safeInputTitle` scans the whole candidate (a secret past the cut-off cannot leave
its start behind) and stores `Note <date>` or `File <date>` on a hit. Every held note gets the neutral title and keeps it after
Confirm; the title is outside the hold digest. `removeInput` overwrites the title and clears text, digests, notes, errors and
people, keeping id, kind, status, timestamps and the source link the guard needs. Outcome notes and diagnostics never carry a title.

## Commit text

`sanitizeCommitMessage` strips every caller-authored `Weaver-*:` line; trailers come only
from `commitAll` options. Summaries can therefore never forge `Weaver-Run-Id` and friends.
