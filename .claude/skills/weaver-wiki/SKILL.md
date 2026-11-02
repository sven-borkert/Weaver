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

## Commit text

`sanitizeCommitMessage` strips every caller-authored `Weaver-*:` line; trailers come only
from `commitAll` options. Summaries can therefore never forge `Weaver-Run-Id` and friends.
