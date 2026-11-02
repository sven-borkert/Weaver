---
name: weaver-wiki
description: Use when changing Weaver's wiki-agent foundations: page `properties` (type, summary, tags, sources, reviewExempt), the `Document.wiki*` projection, wiki read services and the MCP `wiki` toolset (find_page, inspect_links, list_recent_changes), change kinds, or tracked-link teaching in prompts.
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
- `packages/assistant-tools/src/tools/wiki.ts` registers the tools in `WIKI_TOOLS` and the
  MCP `wiki` toolset only; the assistant gets them with the wiki settings (later slice).
- Links: `wiki/links.ts` `trackedLink` builds the paste-ready `[Title](weaver://document/<id>)`;
  prompts, MCP instructions and document write descriptions teach only that form.

## Principal (no runner yet)

- `WikiAgent` (`services/wikiAgents.ts`): one live row per project (partial unique index),
  no `User`, `Member` or bearer credential; revoked rows stay so old commits resolve.
- `createWikiAgentSecurityContext({ agentId, projectId })` builds the principal; ids come
  from the run row. It carries `content:read` and `content:write` for one project.
- `resolveProjectAccess` gives it a synthetic `Editor` while the agent row is live and the
  project is not deleted, `NOT_FOUND` otherwise; the enabled check arrives with
  `ProjectWikiSettings`. See `weaver-auth` for which services accept the union.
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

## Commit text

`sanitizeCommitMessage` strips every caller-authored `Weaver-*:` line; trailers come only
from `commitAll` options. Summaries can therefore never forge `Weaver-Run-Id` and friends.
