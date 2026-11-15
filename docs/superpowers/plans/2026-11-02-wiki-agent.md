# Wiki Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. The spec is the design authority: every task implements the named spec sections in full, and this plan only records what the spec leaves open plus shared names.

**Goal:** A per-project, unattended, LLM-maintained wiki: Input queue → durable source pages → agent-patched wiki pages, scheduled lint, per-run Revert, with its own machine identity.

**Architecture:** Slices 1–4 widen documents, attribution and the principal without any model. Slice 5 adds the queue, sources and worker role with no model. Slice 6 adds `packages/ai/src/wikiRunner.ts` (injected like the task runner) with agent-only tools writing through a narrow operation union. Slices 7–8 add lint, classify and Save as page.

**Tech Stack:** Next.js 16, tRPC 11, Prisma 7 + hand-written SQL, pg-boss, ai SDK 7, simple-git via `@weaver/git-store`.

**Spec:** `docs/superpowers/specs/2026-11-02-wiki-agent-design.md` (revision 4; §N below refers to it).

## Global Constraints

- Migrations are hand-authored SQL, timestamp after `20261025150100`, applied with `pnpm db:migrate`, `pnpm db:test:migrate`, `pnpm db:e2e:migrate`; never `prisma migrate dev`; `ALTER TYPE` in separate migrations.
- No `@@map`; every filtered FK gets `@@index`; partial uniques and CHECKs live in SQL with a schema comment; raw SQL timestamps use `UTC_NOW`.
- Agent identity: no `User` row, no `Member` row, no bearer credential; no agent commit carries `Weaver-User-Id`; no FK column receives the agent id.
- Trust only ledger-trusted commits (`trustedAuthor === true`) for badges, ownership, recovery and the log; never derive anything from the header author name.
- Limits, verbatim: guide ≤ 16,000 B; note ≤ 200,000 chars; queue ≤ 200; 10 items per ingest run; 75-minute preparing limit; non-owned page `find` ≤ 500, ≤ 2,000 gross and ≤ 10,000 added per page per run, ≤ 20,000 gross and ≤ 50,000 added per run; 24-hour budget default 100,000; run caps per the §8.2 table; lease 60 s, heartbeat 15 s; 2 restarts; `wiki.run` expiry ≥ 125 min, concurrency 1, `retryLimit: 0`; preflight window ≥ 100,000, `maxOutputTokens` ≥ 8,192; `WikiRunOperation` retention 90 days; `wiki_note` ≤ 8,000 chars per item; 5 suggestions per run, each ≤ 1,000 chars; summary ≤ 4,000.
- Operation ids: `wiki-run:<runId>:<nnnn>`, `wiki-input:<itemId>`, `wiki-revert:<runId>:<nnnn>`, `ingestion:<fileId>`.
- Every slice updates `docs/IMPLEMENTATION.md`, `docs/CHANGELOG.md` and the §15 skills it touches in the same commit, and runs `pnpm check`, `pnpm format:check`, `pnpm test` plus its Tier 2 specs. Tier 3 only with the owner's consent. Never run integration specs from two processes at once.
- Comments: one short line maximum, only for a non-obvious why. Follow the surrounding code. Next.js here differs from training data: read `apps/web/node_modules/next/dist/docs/` before touching routes.

## Review Focus

1. A pulled or hand-edited file whose `properties` line is malformed, oversized, or claims `type: source` / `reviewExempt`: the file stays readable, bad values drop, and no reserved flag grants anything. Test in Task 1.1.
2. A note or file name that is empty after stripping bidi and default-ignorable characters, whitespace-only, or colliding with an existing slug: refused at add or given a stable fallback title, never an empty title. Test in Task 5.3.
3. Two Editors pressing Process at the same moment, or disable or Remove during a run: one `RUN_ACTIVE`, no item in two runs, no commit after the fence closes, every item ends in a known state. Tests in Tasks 5.2, 6.4.
4. A human edit during a run on a page the run owns: ownership drops at that commit, budgets switch to non-owned, Revert skips and lists that page. Tests in Tasks 6.3, 6.7.
5. No `wiki` route, an unsuitable route or no worker consuming the role: Process and lint fail visibly (`ROUTE_UNSUITABLE`, "no worker is consuming wiki runs"), items return to `queued`, nothing hangs in `preparing`/`queued`. Tests in Tasks 5.4, 6.5.

---

## Slice 1: Properties reader, link teaching, MCP wiki reads (§7.2 reader, §7.3 teaching, §7.6, §13.1)

### Task 1.1: Tolerant `properties` header

**Files:** Create `packages/core/src/wiki/properties.ts`, `properties.test.ts`. Modify `packages/core/src/documents/frontmatter.ts`, `frontmatter.test.ts`.

**Interfaces — Produces:**

- `WIKI_PAGE_TYPES` (§7.2 vocabulary), `type WikiPageType`
- `type WikiSourceRef = { kind: "document"|"table"|"artifact"|"url"; id?: string; url?: string }`
- `type WikiPageProperties = { type?: string; summary?: string; tags?: string[]; sources?: WikiSourceRef[]; reviewExempt?: boolean }`
- `normalizeProperties(raw: unknown): WikiPageProperties | null` (drops invalid values, null when empty, canonical key order)
- `DocumentMeta.properties?: WikiPageProperties`

- [ ] Write failing tests: round trip for Markdown and Python; absent stays byte-identical; `properties` line follows `appearance`; bad JSON, wrong types, over-limit lengths, `url` not http(s) are dropped and the file still parses; `>` stays encoded; unknown keys dropped; `type: "source"` and `reviewExempt` read back as plain data and grant nothing by themselves.
- [ ] Run `pnpm --filter @weaver/core exec vitest run src/wiki/properties.test.ts src/documents/frontmatter.test.ts`. Expected: FAIL.
- [ ] Implement in `headerSource`/`headerLines`/`metaFromGroups` the same way as `appearance`.
- [ ] Run tests. Expected: PASS. Commit.

### Task 1.2: Projection columns and carrying properties through writers

**Files:** Migration `<ts>_wiki_page_properties` (add `Document.wikiType`, `wikiSummary`, `wikiTags` jsonb, `wikiSources` jsonb, `reviewExempt` boolean default false, `wikiSourceItemId` uuid nullable without FK, `DataTable.wikiSourceItemId` same). Modify `schema.prisma`, `services/documents.ts` (`documentMetadataColumns`, restore, write tail), `contentRecovery.ts`, `documentHeaderUpgrade.ts`, `documentReview.ts` writers, moves.

**Interfaces — Produces:** projection columns; every rewrite of a header carries `meta.properties`. Rebuild derives the columns from the header.

- [ ] Failing integration tests in `documents.spec.ts`: file with a properties line pulled into the repo projects columns via `rebuildIndex`; save, move, review commit and version restore preserve the line; `reviewExempt: true` in a header produces no review block on create defaults, in the upgrade backfill and in recovery, and `reviewDueAt` stays null.
- [ ] Write migration, apply to all three databases, `pnpm db:generate`.
- [ ] Implement. Run `pnpm test:integration:documents`. Expected: PASS. Commit.

### Task 1.3: Author predicate split and `Weaver-*` reservation

**Files:** `services/contentAuthor.ts`, `services/documents.ts:1154`, `packages/git-store/src/gitStore.ts`.

**Interfaces — Produces:** `hasNoUser(actor)`, `skipsLabelEnrichment(actor)` (true only for `projectApiKey`), `machineIdentity(actor): { machineKind, machineId } | null`; removes `isMachineContentAuthor`. `sanitizeCommitMessage` strips any line matching `/^\s*Weaver-[A-Za-z-]+\s*:/i`, and internally added trailers are appended after sanitizing.

- [ ] Failing tests in git-store unit tests and `gitStore.spec.ts`: a change summary containing `Weaver-Run-Id: x` or `weaver-operation-id: y` does not forge a trailer; legitimate trailers passed through the metadata parameters still appear. Verify first which callers pass their trailers through `message`, and move those to a trailers parameter so they survive.
- [ ] Implement; run `gitStore.spec.ts`, `projectApiAttribution.spec.ts`, `projectApiPublishing.spec.ts`. Commit.

### Task 1.4: `find_page`, `inspect_links`, `list_recent_changes`; link teaching; MCP `wiki` toolset

**Files:** Create `packages/assistant-tools/src/tools/wiki.ts`; `packages/core/src/services/wikiReads.ts`. Modify `registry.ts`, `toolsets.ts`, `toolsetNames.ts`, `registry.test.ts`, `toolsets.test.ts`, `instructions.ts`, `instructions.test.ts`, `packages/ai/src/prompt.ts`, `prompt.test.ts`, `mcpServer.spec.ts`.

**Interfaces — Produces:** contracts `find_page { projectId, title?, slug?, path?, includeSources? }`, `inspect_links { projectId, mode: "orphans"|"dangling"|"backlinks", documentId?, cursor? }`, `list_recent_changes { projectId, since?, cursor? }` with `kind` derived from operation-id prefixes per §7.5 and untrusted commits reported `external`. Wiki-agent versions in Slice 6 reuse the same services and drop `projectId`.

- [ ] Failing tests: `assistantTools.spec.ts` for scope `NOT_FOUND` on a second project and bounded output; `find_page` returns a paste-ready `[Title](weaver://document/<uuid>)` and excludes `wikiSourceItemId` pages unless asked; orphan and dangling modes; kinds per prefix, untrusted → `external`; `instructions.test.ts` asserts the resource URI sentence is gone and the tracked link form is present.
- [ ] Implement; add the tools to the MCP `wiki` toolset only (the assistant gets them in Slice 3). Measure: `prompt.test.ts` and `registry.test.ts` pinned lists updated.
- [ ] Run `assistantTools.spec.ts`, `mcpServer.spec.ts`, `pnpm test`. Close changelog into a version heading. Commit.

## Slice 2: Identity and principal (§5.2, §5.3)

### Task 2.1: Discriminated `SecurityContext`

**Files:** `packages/core/src/security/context.ts`, `actor.ts`, `projectAccess.ts`, scope resolution, four task deny-lists, then every `actor.userId` compile error.

**Interfaces — Produces:**

```ts
type UserPrincipal = { kind: "user"; userId: string; globalRole: GlobalRole; ... };
type WikiAgentPrincipal = { kind: "wikiAgent"; agentId: string; projectId: string; authenticationMethod: "wikiAgent"; credentialId: `wiki-agent:${string}`; capabilities: {content:read, content:write}; allowedProjectIds: Set<[projectId]> };
type SecurityContext = UserPrincipal | WikiAgentPrincipal;
createWikiAgentSecurityContext({ agentId, projectId }): WikiAgentPrincipal
isHumanPrincipal(c): c is UserPrincipal
requireUserId(c): string  // throws FORBIDDEN for machine principals
```

`resolveProjectAccess` returns synthetic `Editor` for its own project while the agent is live and the feature enabled, else `NOT_FOUND`.

- [ ] Failing tests in `securityContext.spec.ts`: second project `NOT_FOUND`; revoked agent `NOT_FOUND`; deny-lists refuse the method; `listProjectsForUser` yields only P.
- [ ] Implement; `pnpm typecheck` is the audit of all ~240 sites. Each site is `isHumanPrincipal` narrowing or `requireUserId`, failing closed, with no cast.
- [ ] Run `pnpm check`, `pnpm test`, `securityContext.spec.ts`, `assistantTools.spec.ts`. Commit.

### Task 2.2: `WikiAgent`, `weaver.invalid`, machine commit authors, editor pair

**Files:** Migration `<ts>_wiki_agent_and_machine_editor` (`WikiAgent` + partial unique; `Document`/`DataTable.lastEditedByMachineKind`, `lastEditedByMachineId`, backfill, CHECK). `gitStore.ts` (`CommitAuthor`, two log formats, trailers `Weaver-Wiki-Agent-Id`, `Weaver-Wiki-Request-Hash`, `resolveAttribution` new branch with `trustedAuthor === true`), `contentAuthor.ts`, `documents.ts`, `tables.ts`, `dashboard/content.ts`, `activity.ts`, explorer and history read models, user creation, OIDC provisioning. Create `services/wikiAgents.ts`.

**Interfaces — Produces:**

```ts
CommitAuthor = { kind: "machine"; machineKind: "projectApiKey"|"wikiAgent"; machineId: string; name; email } | { name; email; userId }
MachineContentAuthor = { kind: "wikiAgent"|"projectApiKey"; projectId; machineId; name: "Wiki agent"; email: `wiki-agent+<id>@weaver.invalid` }
createWikiAgent(tx, projectId), revokeWikiAgent(...), getLiveWikiAgent(projectId)
```

History and explorer items gain `machineEditor: { kind, id, name } | null`. Dual-write `lastEditedByProjectKeyId` this release; readers switch to the pair.

- [ ] Failing tests: commit author serialization and both log formats (unit); agent commit has `Weaver-Wiki-Agent-Id`, no `Weaver-User-Id`; untrusted commit with agent trailers reads `external`; `projectApiAttribution.spec.ts`/`projectApiPublishing.spec.ts` pass with the pair written and the old column dual-written; creating a user with `@weaver.invalid` refused in both paths; Activity "Changes by others" includes machine editors; an agent write rewrites link labels.
- [ ] Implement, apply migration, run listed specs. Commit.

### Task 2.3: Narrow operation union

**Files:** Create `packages/core/src/services/wikiOperations.ts`; extract recover→check→apply from `applyMcpOperation`; widen `applyOperationInRepo` and helpers to `ContentWriteActor`.

**Interfaces — Produces:**

```ts
type WikiOperation = {kind:"document.create",...}|{kind:"document.patch",...}|{kind:"content.lifecycle",action:"folder_create",...};
applyWikiOperation(input: { run: WikiRunFence; operation: WikiOperation; operationId: string; requestHash: string; beforeCommit: () => Promise<void> }): Promise<WikiWriteResult>
```

Refused for the agent: Python documents, task output documents, the guide, source pages and tables, source folders, `weaver-image:` references, `<img>` tags. Recovery for `wiki-*` ids requires trusted author, agent trailer and matching request hash, else `CONFLICT`.

- [ ] Failing tests in `wiki.spec.ts`: iterate every `ContentOperation` kind by name and assert refusal outside the union; second project `NOT_FOUND`; forged trailers in history do not match recovery; guards above refuse.
- [ ] Implement. Run `wiki.spec.ts`, `mcpOperations.spec.ts`, `assistantProposals.spec.ts`. Close changelog. Commit.

## Slice 3: Settings and guide (§5.1, §6, §8.4 bootstrap, §9 `get_wiki_guide`)

### Task 3.1: Settings, bootstrap, guide approval

**Files:** Migration `<ts>_wiki_settings` plus separate `<ts>_llm_purpose_wiki`. Create `packages/core/src/wiki/guideText.ts`, `wiki/templates/guide-v1.md.ts`, `services/wikiSettings.ts`, `apps/web/src/server/api/routers/wiki.ts`.

**Interfaces — Produces:**

```ts
normalizeGuideText(body): { text: string; removed: { kind: string; count: number }[]; digest: string }  // NFC + strip Default_Ignorable_Code_Point and bidi controls; SHA-256
getWikiSettings(ctx, projectId), enableWiki(ctx, { projectId, expectedRevision }), disableWiki, updateWikiSettings, setGuideDocument, reviewGuide(ctx, projectId), approveGuide(ctx, { projectId, expectedRevision, expectedDigest }), revokeAgent, listGuideSuggestions, resolveGuideSuggestion
```

Owner and Maintainer rules and session-only per §5.1. `routes.ts` gets `LlmPurpose.wiki`, chat + tool_use.

- [ ] Failing tests in `wiki.spec.ts`: roles and CAS; enable creates agent, `wiki/`, `wiki/sources/`, guide from template with digest approved, overview stub; re-enable reuses; approval mismatch refused on digest and on revision; over 16,000 B refused; character stripping (unit); guide re-pointing clears approval; `llm.spec.ts`/`llmRoutes.test.ts` pinned lists.
- [ ] Implement. Run specs. Commit.

### Task 3.2: Settings card, route card, `get_wiki_guide`

**Files:** Project settings UI, Administration › AI route card copy, `tools/wiki.ts`, `toolsets.ts`, assistant fixed rules.

**Interfaces — Produces:** tool `get_wiki_guide { projectId }` returning approved text as reference data; assistant gets the read-only wiki tools. Check against `prompt.test.ts` that the assistant budget stays within the measured floor; report the new floor.

- [ ] Failing tests: `assistantRunner.spec.ts`, `mcpServer.spec.ts` guide read; static UI test for the card states.
- [ ] Implement. Run. Close changelog. Commit.

## Slice 4: Properties writer and Index view (§7.2 writers/reads, §7.5)

### Task 4.1: `properties` in write schemas

**Files:** `contentOperations.ts`, operation schemas, `importMarkdown.ts`, `importPython.ts`, `documentImport.ts`, `remoteInstances/{transfer,receive}.ts`, `documentDownload.ts`, ingestion `buildAcceptOperation`.

**Interfaces — Produces:** `properties?: WikiPagePropertiesInput` on create, edit, patch and the tRPC document update; `assertPatchHasWork` counts it; a write-side schema refuses `type: "source"` and `reviewExempt`, with a system-writer path that may set them.

- [ ] Failing tests (`documents.spec.ts`, `transferApi.spec.ts`, `documentArchiveImport.spec.ts`): patch with only properties commits; reserved refused from tools and UI; YAML import maps `type`/`tags`/`summary`, `aliases` into `tags`, `source` ignored; transfer carries fields; a human setting review settings clears `reviewExempt`.
- [ ] Implement, run, commit.

### Task 4.2: Reads and UI

**Files:** `list_documents`, `document.list`, `folder.tree`, `documentsExplorerAdapter.tsx`, `DocumentActionsMenu.tsx`, a properties dialog (read `weaver-forms-dialogs`), Index view route under the documents area.

**Interfaces — Produces:** `type`/`tag` filters and `includeSummary`; explorer columns; `sources` ids resolved within the project and viewer access, urls plain text with an external marker; Index view grouped by type.

- [ ] Failing tests: list filters in `documents.spec.ts`, static component tests, cross-project source id does not resolve.
- [ ] Implement; `pnpm check`; release note per §7.2 Rollout rule. Close changelog. Commit.

## Slice 5: Queue and sources, no model (§7.1, §7.4, §8.1, §8.2 jobs, §12)

### Task 5.1: Secret scanner

**Files:** Create `packages/core/src/security/secretScan.ts`, `secretScan.test.ts`.

**Interfaces — Produces:** `scanForSecrets(text: string, where: string): SecretHit[]` where `SecretHit = { kind: string; location: string }` and never the value. Families per §8.1.

- [ ] Failing corpus tests: each named family positive and near-miss negative; `IBAN` checksum and Luhn; no output contains the value.
- [ ] Implement, pass, commit.

### Task 5.2: Models, role plumbing, tick skeleton

**Files:** Migrations (`WikiInputItem`, `WikiRun` with the partial unique, `WikiGuideSuggestion` if not already, FK on `wikiSourceItemId`, `AiUsage.sourceCommitSha`, separate `PersonalWorkKind.wiki` and `IngestionOrigin.wiki`). §8.2 role plumbing list verbatim. Create `services/wikiRuns.ts`, `services/wikiInputs.ts`, `services/wikiTick.ts`. Diagnostics category and events per §12.

**Interfaces — Produces:** `addTextInput`, `addFileInputs`, `listInputs`, `processInputs(ctx, { projectId, itemIds | "all" })`, `retryInput`, `confirmInput`, `removeInput`, `cancelRun`, `runWikiTick(ctx)`; state-transition helpers in pure `wiki/states.ts` with unit tests.

- [ ] Failing tests: state machine unit; concurrent Process: one `RUN_ACTIVE`, no double selection; queue cap; 10-item selection oldest first; `runtime.test.ts`, `compose-services.test.mjs`, worker tests for the role.
- [ ] Implement, run, commit.

### Task 5.3: Source writer

**Files:** Create `services/wikiSourceWriter.ts`.

**Interfaces — Produces:** `writeTextSource(run, item)`, `writeFileSource(run, item, file)`, fenced by `assertPreparingFence`; `sourceTitle(name)` strips default-ignorable and bidi characters and falls back to `Source: untitled` when empty. `wikiSourceItemId` threaded through `WriteRequest`, `PreparedWrite`, `persistDocumentProjection` and re-derived in rebuild and repair and recovery.

- [ ] Failing tests: Review Focus 2; folder deleted is recreated by id; `-2` slug; fence refusals per condition; resume rule; text retained until `processed`/`removed`; agent trailer present; rebuild re-derives the column.
- [ ] Implement, run, commit.

### Task 5.4: Import bridge, Imports isolation, artifact protection, AI exemption

**Files:** `services/ingestion*.ts`, `packages/ingestion` parse runner, `services/artifacts.ts`, `services/knowledge/*` (`isAiExempt` TS and SQL), `documents/indexLight.ts`, Index tab.

- [ ] Failing tests: `ingestion.spec.ts` wiki origin hidden and refused; parse → `ready` → accepted by tick; secret hit → `held`, Confirm digest-bound; 75-minute timeout marks unparsed `failed` (Review Focus 5); `SOURCE_PROTECTED`; `knowledgeIndex.spec.ts` exempt build completes, activates, both flips; TS and SQL predicate agreement.
- [ ] Implement; run `pnpm test:integration:ingestion`, `pnpm test:integration:knowledge`, `artifacts.spec.ts`. Commit.

### Task 5.5: Wiki section, Input tab, Activity and bell

**Files:** `apps/web/src/app/(workspace)/projects/[projectId]/wiki/**`, sidebar, `apps/web/src/server/api/routers/wiki.ts`, `backgroundWorkSchema.ts`, `destination.ts`, `presentation.ts`, `BackgroundWorkScreen.tsx`, upload client helper returning created ids.

- [ ] Failing tests: `backgroundWork.spec.ts`; router role matrix (Viewer sees, Editor acts); static UI tests.
- [ ] Implement per §8.1 mockup. `pnpm check`. Close changelog. Commit.

## Slice 6: Runner and ingest (§7.3, §8.2–8.3, §8.6)

### Task 6.1: Link pre-processing and budget accounting (pure)

**Files:** `packages/core/src/wiki/agentMarkdown.ts`, `wiki/budget.ts`, tests.

**Interfaces — Produces:** `preprocessAgentMarkdown(md, resolver): { markdown, unresolvedLinks, invalidLinks }`; `measurePatch(compiled): { grossCharsChanged, charsAdded }`; `checkBudget(page, run, delta, owned): BudgetDecision`.

- [ ] Failing unit tests including same-length replace counted as gross. Implement. Commit.

### Task 6.2: Runs ledger and ownership

**Files:** Migration (`WikiRunOperation`, `WikiOwnedPage`, `WikiPageBudget`); `services/wikiOwnership.ts`; hook in `persistDocumentProjection` and the §8.2 writers.

- [ ] Failing tests: Review Focus 4 ownership per projection writer; write-time check with `repo.lastCommitForPath`. Implement. Commit.

### Task 6.3: Agent tools

**Files:** `packages/assistant-tools/src/tools/wikiAgent.ts`, `wikiAgentRegistry.ts`; `applyWikiOperation` budget and reservation integration.

**Interfaces — Produces:** exactly the §8.2 tool surface; `WIKI_AGENT_TOOLS` plus `WIKI_AGENT_LOADABLE_TOOLS`, no `projectId` in any input.

- [ ] Failing tests: registry pin; no wiki contract reaches `applyMcpOperation`; stale base `CONFLICT STALE_BASE`; budget refusals; after 3 refusals the run stops; `complete_input` `NOT_INTEGRATED`; idempotent `wiki_create_page`; non-owned property limits; agent label enrichment. Implement. Commit.

### Task 6.4: Runner with elision

**Files:** `packages/ai/src/wikiRunner.ts`, `wikiElision.ts`, `wikiPrompt.ts`, tests; worker injection.

**Interfaces — Produces:** `createWikiRunner(deps): (input: { runId, signal }) => Promise<void>`; `elideMessages(messages, { maxInputBytes, parallelCalls, exemptIds }): messages`.

- [ ] Failing tests: elision unit incl. 200,000-char source at 100,000 window completing without `CONTEXT_LIMIT` under a scripted model; fence on disable aborts and no commit follows; `suppressProviderBodies`; `AiUsage` upserted per step; system prompt contains no authored text except the guide. Implement. Commit.

### Task 6.5: Restart, reconcile, caps, preflight

**Files:** `services/wikiTick.ts`, `wikiRuns.ts`.

- [ ] Failing tests: lease expiry restart ≤ 2; quarantine after 2; briefing from ledger; reserved operation reconciled; `ROUTE_UNSUITABLE`; auto-cancel without worker; caps stop and return items; 24-hour pause and auto-clear; spend alert notifies and does not stop. Implement. Commit.

### Task 6.6: Runs tab and usage UI

**Files:** `wiki/runs` route, `routers/wiki.ts`, `AiUsage.sourceCommitSha` set by enrichment.

- [ ] Failing tests: router lists, indexing cost join, Maintainer+ only for cost; static UI. Implement. Commit.

### Task 6.7: Revert

**Files:** `services/wikiRevert.ts`; `restoreDocumentInRepo` explicit properties input.

**Interfaces — Produces:** `startRevert(ctx, { projectId, runId })`, authored by the Editor, own two-kind writer unreachable from dispatch.

- [ ] Failing tests per §8.6: created pages soft-deleted, restored pages, human-edited skipped and listed, allowed while disabled, revoked or paused, not budget-counted, items → `reverted`, only newest run per page. Implement. Close changelog. Commit.

## Slice 7: Lint and classify (§8.4–8.5)

### Task 7.1: Lint

**Files:** `wikiPrompt.ts` lint protocol; new read model in `services/wikiReads.ts`; `wikiTick.ts` schedule claim using `nextOccurrence`; settings UI.

- [ ] Failing test and fix for `list_recent_changes`: a backdated untrusted commit on a merged side branch must appear for any `since`. Replace the date stop with an ancestry boundary: newest first-parent trusted commit older than `since`, then walk `<boundary>..HEAD`; show merge file changes for untrusted merges.
- [ ] Failing tests: conditional claim once; skip while active; 5 failures pause; manual hourly limit; `inspect_links`-driven scripted run writes the report at `reportDocumentId`; mentions read model active generation only. Implement. Commit.

### Task 7.2: Classify

**Files:** `services/wikiClassify.ts`, Runs tab action. `plan` jsonb, `planDigest`.

- [ ] Failing tests: preview without write tools stores plan and usage; accept applies exactly the stored plan as property-only patches, 100 pages; changed plan digest refused. Implement. Close changelog. Commit.

## Slice 8: Save as page (§9)

### Task 8.1: Save as page

**Files:** Assistant message actions, a create dialog, `document.create` with properties.

- [ ] Failing tests: prefill mapping (unit): `wiki/`, `synthesis`, citations in the target project checked and others unchecked with warning. Implement; `pnpm check`. Close changelog. Commit.

## Completion

- [ ] New skill `.claude/skills/weaver-wiki/SKILL.md` + `.codex/skills/weaver-wiki` symlink exist from Slice 3 on; §15 skills updated by their slices.
- [ ] Add e2e `apps/web/tests/e2e/wiki.spec.ts` plus mock AI persona; authored in Slice 6. Executing it is Tier 3.
- [ ] Whole-branch review of each slice before merge.
