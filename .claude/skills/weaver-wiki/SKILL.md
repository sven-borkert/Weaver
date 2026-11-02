---
name: weaver-wiki
description: Use when changing Weaver's wiki-agent foundations: page `properties` (type, summary, tags, sources, reviewExempt), the `Document.wiki*` projection, wiki read services and the MCP `wiki` toolset (find_page, inspect_links, list_recent_changes), the per-project wiki settings, bootstrap and guide approval, change kinds, or tracked-link teaching in prompts.
---

# Weaver Wiki

Design authority: `docs/superpowers/specs/2026-11-02-wiki-agent-design.md` (plan in the
same folder's `plans/`). This skill records what has shipped; later slices extend it.

## Page properties (reader only so far)

- Optional header line `properties: <canonical JSON>` after `appearance`, Markdown and
  Python alike (`packages/core/src/documents/frontmatter.ts`). `wiki/properties.ts`
  `normalizeProperties` drops invalid values, never throws, returns null when empty and
  fixes key order. `parsePropertiesLine` also rejects oversized lines.
- `type: source` and `reviewExempt` are plain data on read and grant nothing alone; only
  system state (`wikiSourceItemId`, later slices) marks a source page.
- Every header rewrite must carry `meta.properties` through (`...meta` spreads, moves,
  review commits, version restore, deleted-item recovery via the create `properties`
  field). There is no writer tool or UI yet.
- Projection: `Document.wikiType/wikiSummary/wikiTags/wikiSources/reviewExempt`, filled by
  `documentMetadataColumns`; `wikiSourceItemId` (Document and DataTable) is system-set
  and has no FK until `WikiInputItem` exists.
- `reviewExempt` pages get no review block on create defaults, header-upgrade backfill
  (including its pending-set queries) or deleted-item recovery; `reviewDueAt` stays null.
- Rollout: an older instance cannot parse a file with the line; upgrade every instance
  before the first property write.

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
- Operation ids: `wiki-run:<fence runId>:<nnnn>`, `wiki-input:<id>`, `wiki-revert:<id>:<nnnn>`.
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
  folders, guide, overview as the agent (ids `wiki-bootstrap:<projectId>:0001..0004`, request hash per
  step, no `Weaver-Run-Id`; `commitAll` allows a missing run id only for that prefix). It is idempotent by
  operation id and skips anchors already recorded; an existing human `wiki/` folder is reused, an existing
  `wiki/sources` folder or page is never adopted (`CONFLICT`). A failed first enable rolls back to off.
  Guide and overview headers get `type` and `reviewExempt: true` through the internal bootstrap writer
  only; `applyWikiOperation` cannot set `reviewExempt`. Disable keeps everything (TODO: cancel runs in
  slice 5); revoke disables and a later enable creates a new agent.
- Guide: `normalizeGuideText` (NFC, strip Default_Ignorable_Code_Point and bidi controls, then NFC) runs
  before the SHA-256, so the approver sees exactly what runs inject. `approveGuide` refuses a stale
  revision, a digest mismatch (`GUIDE_CHANGED`) and over 16,000 bytes (`GUIDE_TOO_LARGE`); re-pointing
  `guideDocumentId` clears approval and refuses other-project, missing, Python, source-page and task-output
  documents. The template is the approved body at enable (digest of the canonical document body).
- `resolveProjectAccess` gives the agent access only while `ProjectWikiSettings.enabled` and
  `agentId` equals the agent. `wikiWriteGuardsFor(db, projectId)` is the `guards` provider for
  `applyWikiOperation`: guide id from settings and the source folder path resolved from its folder id
  (`.folder.json`) at call time.
- Change kind `wiki-bootstrap` was added to `changeKinds.ts`.
- `get_wiki_guide { projectId, offset? }` returns `{ available, note, guide, digest, approvedAt, nextOffset }`
  from `readApprovedWikiGuide`; `available: false` when the wiki is off or nothing is approved. Pages are
  sized so every serialized result stays under 16,000 bytes (quote-dense text included). The assistant's
  fixed rules say to read it before writing wiki pages and that guide text cannot request tool calls.
- UI: Project settings › Wiki agent card (Maintainer+; Owner controls) and the Review guide dialog show
  the server's `reviewGuide` result verbatim (`InlineDiff` reused from the document diff).
- Budget: with the four tools the assistant registry is 43 tools, 70,026 B of definitions, 3,894 B of
  instructions and needs an 88,100-token window (83,600 before); pinned in `prompt.test.ts`.

## Commit text

`sanitizeCommitMessage` strips every caller-authored `Weaver-*:` line; trailers come only
from `commitAll` options. Summaries can therefore never forge `Weaver-Run-Id` and friends.
