---
name: weaver-wiki
description: Use when changing Weaver's wiki agent: page `properties` (type, summary, tags, sources, reviewExempt), the `Document.wiki*` projection, wiki read services and the MCP `wiki` toolset, per-project wiki settings, bootstrap and guide approval, the input queue, runs, the runner, agent tools and budgets, Revert, scheduled and manual lint maintenance, Classify existing pages, Save as page, the Runs tab, source writer and Input page, change kinds, or tracked-link teaching in prompts.
---

# Weaver Wiki

This skill records what has shipped.

## Page properties

- Optional header line `properties: <canonical JSON>` after `appearance`, Markdown and
  Python alike (`packages/core/src/documents/frontmatter.ts`). `wiki/properties.ts`
  `normalizeProperties` drops invalid values, never throws, returns null when empty and
  fixes key order. `parsePropertiesLine` also rejects oversized lines.
- `type: source` and `reviewExempt` are plain data on read and grant nothing alone; only
  system state (`wikiSourceItemId`) marks a source page.
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
  schema. `assertPatchHasWork` counts `properties`. `applyWikiOperation`'s narrow schema takes the tool subset (see Agent tools).
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
  so a user-only service does not compile inside them. Every read the agent reaches uses it. For the agent `content_history`
  is commit metadata only, with null subject and author on untrusted commits.

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
  markup cannot be assembled from existing text. Existing images stay.
- Operation ids: only `wiki-run:<fence runId>:<nnnn>`. The agent cannot mint `wiki-input:`, `wiki-revert:` or `ingestion:` ids.
- Recovery goes through `recoverCheckApply` with identity `{ wikiAgentId, wikiRequestHash }`: a
  match needs `trustedAuthor === true`, the agent trailer and the hash, else `CONFLICT`. A patch
  retried with a newer base still finds its own commit first, so it cannot apply twice.

## Settings, bootstrap and guide

- `ProjectWikiSettings` (`wikiSettings.ts`, router `wiki`) follows the `ProjectGitRemote` pattern: 1:1,
  integer `revision` CAS on every write (0 means no row yet), session actors only, Owner enable /
  disable / revoke / budgets / guide pick, Maintainer settings read, review and approve; non-members
  (including global Admins) get `NOT_FOUND`. Anchor ids (`guideDocumentId`, `sourcesFolderId`, ...) are
  plain uuids without FKs. The lint schedule (Owner) and budgets are edited through `wiki.update`; `reportDocumentId` and the lint streak are system-written.
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

## Input page

`wiki/_components/WikiInputScreen.tsx` over `wiki.input.*` (`list`, `addText`, `addFiles`, `process`, `retry`, `confirm`, `remove`, `unlinkArtifact`) and
`wiki.cancelRun`, session actors only. `uploadInputFiles` retries a name clash as `name-2.ext`, never replacing a file in Files.
`wikiRunNotice` words `RUNNER_UNAVAILABLE` and `NO_WORKER` plainly; codes never reach the page.

## Ownership and the run ledger

- `WikiRunOperation` (ids `wiki-run:<runId>:<nnnn>`, `n` 1..9999) drives Revert, the restart briefing, `complete_input` and the
  rolling 24-hour sum. `WikiPageBudget` keeps non-owned counters per page per run so a restart cannot reset them.
- `WikiOwnedPage` is a cache. `deriveOwnership`/`applyOwnershipDecision` (`wikiOwnership.ts`) run inside `persistDocumentProjection`'s
  transaction and in `rebuildIndex`; a move deletes the row. Only ledger-trusted `wiki-run:` commits of a live agent own; source and
  bootstrap commits never do, and an agent commit cannot paper over a missed human commit. Revoke deletes the rows.
- At write time `isOwnedAtWrite` needs the row, this agent's run and `lastCommitForPath === lastAgentCommitSha`, so a missed hook or a
  Git pull fails safe to non-owned.
- `leaseWikiRun`, `heartbeatWikiRun`, `assertLiveWikiRun` and `wikiRunFence` (`wikiRuns.ts`): lease 60 s, heartbeat 15 s. The fence shares its
  liveness core with `assertPreparingFence`. The runner heartbeat aborts only on a closed fence or lost lease; other errors retry until 60 s pass since the last good heartbeat.

## Agent tools

- `tools/wikiAgent.ts` and `wikiAgentRegistry.ts`: `WIKI_AGENT_TOOLS` (always active) and `WIKI_AGENT_LOADABLE_TOOLS` (through `load_tools`, charged to a
  schema reserve); `WIKI_AGENT_DISPATCH` is the allowlist. None takes `projectId`: `runScopedRead` omits it and the run row supplies it. Definitions measure
  13,995 B always and 8,638 B loadable (the lint reads are loadable), pinned in `wikiAgentRegistry.test.ts`.
- `WikiRunSession` (`wikiRunSession.ts`) is the tools' only way in: inputs, notes, suggestions, `finish_run` and the writes. A write reserves `n` atomically
  under the fence, then `applyWikiOperation` runs with a ledger. In an ingest run a write needs `read_input` first, so every page gets that input's source reference (folder creates included). The reserve step also enforces the write cap (reserved plus committed ops, under the run-row lock; folder creates count). Once `applyWikiOperation` returns, an op is never `failed`: a lost `committed` update stays `reserved` for reconciliation. A patch that changes no body text and no property is `NO_CHANGE`. `summary`, outcome notes and `wiki_note` have control, bidi and format characters stripped, not refused. `finish_run` with unfinished items ends the run `stopped` / `unfinished_items`.
- `applyWikiOperation` enforces ownership and budgets itself under the project lock on the worktree body (`admitPatch`, `compileDocumentPatch`, `wiki/budget.ts`),
  so no caller can skip them. Gross is what edits replace or remove; added is everything edits insert. Owned pages are unlimited; `WikiPageBudget` holds non-owned writes only.
  Counters are written in `beforeCommit`, so a crash over-counts and never forgets. Three refusals stop the run.
- The agent's `properties` are `type`, `summary`, `tags`; `reviewExempt` and `sources` come only from the internal path. `complete_input integrated` needs a committed
  operation with `sourceReferenced` for that input (`NOT_INTEGRATED`).
- Links: `preprocessAgentMarkdown` resolves `[[Title]]` and relative `.md`, then re-reads the result with `parseDocumentBody` and demotes every `weaver:` target it did not
  verify, to a fixed point, refusing the write if it does not settle. A regex cannot agree with the parser on every destination form. `applyWikiOperation` repeats the check on
  the patched body (`assertNewLinkTargetsExist`), because a fragment can only form a link once it meets the surrounding text.
- A refusal's wording reaches the model (`teachingError`); `toolErrorFromUnknown` would flatten it to "not permitted".

## Runner

- `packages/ai/src/wikiRunner.ts` (`createWikiRunner`, injected in `apps/agent-worker`) uses `streamText` with `prepareStep`: live-run check, notes, elision, fit check, in that order. Without
  the injection `wiki.run` still fails `RUNNER_UNAVAILABLE`. Revert needs no model and runs either way.
- `wikiPrompt.ts`: fixed rules, a protocol per run kind, counts-only index head, then the guide in a labelled block. No other authored string enters the system prompt. Notes return as a
  user-role message labelled as the agent's own; the restart briefing holds ledger fields only. The lint protocol is described under Lint.
- `wikiElision.ts`: oldest tool results become stubs until the array fits `maxInputBytes` minus 16 KB per parallel call of the last step. A written page's call input goes with its result, and
  fully stubbed turns are dropped when stubs alone no longer fit. Exempt: the current input's `read_input` and its latest source window, together at most 25 % of `maxInputBytes`.
- Budget at the minimum route (100,000 window, 8,192 output, 16,000 B guide): fixed prompt 2,815 B (lint 3,810 B), tools 14,015 B, schema reserve 12,500 B, leaving 45,454 B (lint 44,459 B) of input, so the exempt share holds an
  8,000-character window. Pinned in `wikiRunner.test.ts`.
- Failures: `ROUTE_UNSUITABLE`, `GUIDE_UNAVAILABLE`, `CONTEXT_LIMIT`. A closed fence ends the run `cancelled` only if this attempt still holds the lease; a worker shutdown leaves it for restart.
- One `AiUsage` row per attempt (deterministic id), upserted after every step, with provider bodies suppressed.

## Restart and pauses

- `expireWikiRunLeases` (in `reapWikiRuns`, so it runs from `system.reconcile` too) requeues a lost run at most twice. An input live through two lost leases (`lostLeases`, not `attempts`, which counts Process presses) fails `QUARANTINED`.
- `reconcileReservedOperations` runs before each attempt: only a trusted commit with this agent's trailer and the reserved hash counts as committed; anything else under the id is failed and reported.
- `destructivePausedAt` refuses Process, stops a new run at lease and clears in the tick once the sum falls. Pause and spend alert reach Owners through `wikiAlertSourceSql`, a personal bell row whose revision changes per incident.

## Revert and the Runs tab

- `wikiRevert.ts`: `startRevert` (Editor session, terminal run, not a revert, not already reverted, one active run per project) and `executeWikiRevert`, called by the `wiki.run` handler for a
  `revert` run, so it works without the injected runner and while the wiki is disabled, revoked or paused. No tool reaches it. It acts as the starter (task context, Editor re-checked in `beforeCommit`).
- A page is written only if every commit from the run's first commit on that page to head is a trusted commit of that run or of this revert; otherwise it is skipped and listed in `WikiRun.report`
  (`edited_after_run`, `later_run`, `gone`, `source_page`). Created pages are soft-deleted because a first version has nothing to restore; others restore to the run's first base with
  `exactProperties`, so properties and `reviewExempt` return exactly. Items move to `reverted`.
- Ids `wiki-revert:<runId>:<nnnn>` with `Weaver-Wiki-Request-Hash`, the Editor as author, no agent trailer and no `Weaver-Run-Id`; recovery uses the `wikiRevertRequestHash` identity (`trustedAuthor === true`,
  no agent trailer, matching hash). Revert operations do not count toward the 24-hour sum.
- `wikiRunViews.ts`: `listRuns`, `getRun`, `wikiUsageSummary`. Viewer+ read; `indexingCostMicros` is null below Maintainer. The "Wiki agent" badge needs `verified`: the commit's trust, operation id and agent
  trailer from Git, never the ledger row alone. Run maintenance now (Editor+) and Classify existing pages (Owner) sit above the list; a classify run waiting for its plan shows it in the detail drawer with Accept and Reject for Owners.

## Lint

- `wikiLint.ts`: `lintScheduleFields` (preset from `taskScheduleSchema`, derived cron, IANA timezone, first slot via `nextOccurrence`; `null` turns it off),
  `claimDueLintRuns` (called from `runWikiTick`; the settings-row lock plus `lintNextRunAt` compare-and-set claims once; a slot more than 15 minutes late
  is `missed`, others skip as `run_active`, `lint_paused`, `budget_paused` or `agent_unavailable`; the skip lives in `lintSkippedAt`/`lintSkipReason` and clears
  on the next start) and `startMaintenance` (Editor session, enabled wiki, live agent, no active run, not budget-paused, one manual start per hour with a
  `RATE_LIMITED` CONFLICT naming the retry time). A lint run is created `queued` (it has no preparation phase) with no starter when scheduled.
- `endRunInTx` calls `recordLintOutcome`: succeeded resets `lintConsecutiveFailures`; failed, or stopped with an error code, adds one; cancelled and clean stops do
  nothing. Five set `lintPausedAt` (schedule skips, manual runs still work); an Owner clears it with `wiki.clearLintPause`. The settings view carries schedule,
  next run, pause, streak, last skip and `reportDocumentId`; `wiki.update` takes `lintSchedule` and `lintTimezone` (Owner).
- Prompt: `wikiPrompt.ts` has a lint protocol (checks in order, only the allowed fixes, the report rules) and `buildWikiStartMessage` takes a `WikiLintContext`
  (today, previous successful lint start, report page id), all system-side facts. A lint restart is briefed from the run's committed operations.
- Session rules for kind `lint`: `read_input`, `complete_input` and `wiki_note` refuse ("applies to ingest runs only"); writes need no current input; folder creates are
  refused; the only page create is the report (`type: report`, `REPORT_EXISTS` once `reportDocumentId` points at a live page), recorded with a conditional update after the
  commit. A human-edited report is non-owned, so the prompt tells the agent to append a dated section.
- Reads (loadable, lint only): `list_missing_entity_pages` (`EntityMention` x `GraphEntity` of the active generation, source pages not counted, entities with a page or alias
  title excluded, at least three pages, keyset cursor) and `list_pages_with_newer_sources` (`wikiSources` document or table ids whose `lastEditedAt` is after the page's).
  `list_recent_changes` with `since` walks `<boundary>..HEAD` where the boundary is the newest trusted first-parent commit older than `since`; untrusted dates never end the walk.
- Measured at this slice: always-active tool definitions 13,995 B (the `load_tools` description lists the new names), loadable 8,638 B, ingest prompt 2,815 B, lint prompt 3,810 B,
  minimum input at the 100,000 window 45,454 B (ingest) and 44,459 B (lint); pinned in `wikiAgentRegistry.test.ts` and `wikiRunner.test.ts`.

## Classify

- `wikiClassify.ts`: Owner session actions `startClassify` (a `classify` run in `preparing`, no plan), `acceptClassifyPlan` (needs the run's `planDigest` as `expectedPlanDigest`;
  a mismatch is `PLAN_CHANGED` and nothing starts; moves the run to `queued`) and `rejectClassifyPlan` (cancels, `plan_rejected`). `cancelRun` on a classify run is Owner only.
- Preview (`packages/ai/src/wikiClassifyPreview.ts`, reached from `executeWikiRun` for a `preparing` classify run): claim by conditional update, one `generateText` call with no tools,
  usage recorded under `wiki.run`. Candidates (`loadClassifyCandidates`) are markdown pages lacking a type or summary, not source pages, not exempt, not the guide, not task outputs, at most 100;
  the model sees title, path and excerpt, cut and stripped, in a fenced data block. `wiki/classifyPlan.ts` turns the reply into a plan: ids must be candidates, only missing fields are
  proposed, every value passes the agent's property schema and the type vocabulary (not `guide`), anything else is dropped. The plan lives in `WikiRun.plan` with `planDigest`.
- Apply (`executeWikiClassify`, called by the `wiki.run` handler for a queued classify run, no model): re-parses the plan (a digest mismatch, reserved type or more than 100 entries is
  `PLAN_INVALID`), then writes each entry through `WikiRunSession.classifyPage` (ledger, ownership, fence, `applyWikiOperation`). A page that changed since the preview, or is now the guide, a source
  page, a task output, Python or exempt, is skipped. Property-only patches charge no gross or added characters; the page count (not the per-property write count) is capped at 100, while
  `WikiRun.writes` still counts one per property changed on a non-owned page. Classify runs are revertible like any run.
- An unanswered plan expires after 24 hours; a lost preview claim is released and the third loss fails the run.

## Save as page

See `weaver-assistant`. The target folder comes from `wikiSaveTarget` (`services/wikiSaveTarget.ts`, Editor): the parent of the recorded sources folder while the wiki is enabled. The page is created by the
signed-in user through `document.create`; the agent is not involved.

## Commit text

`sanitizeCommitMessage` strips every caller-authored `Weaver-*:` line; trailers come only
from `commitAll` options. Summaries can therefore never forge `Weaver-Run-Id` and friends.
