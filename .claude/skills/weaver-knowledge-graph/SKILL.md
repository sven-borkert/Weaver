---
name: weaver-knowledge-graph
description: Use when working on Weaver knowledge indexing, hybrid search, entity/relation extraction, temporal provenance, graph APIs, pgvector queries, pg-boss knowledge jobs, or the graph/search UI.
---

Enrichment and chunk embedding record `AiUsage.sourceCommitSha`; a wiki run's indexing cost joins on it at read time.
Source pages (`Document.wikiSourceItemId` set) are keyword-only. `knowledge/aiExempt.ts` is the one predicate, in TypeScript and SQL,
tested together. Change recording, `resumeGenerationBuild`, carry-forward, `processGenerationDocument` and the route-block paths give
such a document a terminal `ready` row with both indexed shas at head and never a provider call. `flipDocumentAiExempt` handles a changed
link: to exempt it deletes vectors and invalidates mentions and evidence; back it resets the row to pending and enqueues enrichment,
because reconcile would see a complete row.

# Weaver Knowledge Index and Graph

Git Markdown is document truth. PostgreSQL keyword, vector, graph, state, and
usage rows are rebuildable projections. Tables contribute title and column
metadata only—never rows, embeddings, entities, or relations.

## Read and storage invariants

- Every queryable derived row carries `projectId`. Resolve accessible projects
  first, intersect optional requested IDs, and apply that predicate inside
  every lexical/vector/graph query. Never fetch a graph ID before permission
  filtering; inaccessible, deleted, inactive, and unknown resources are
  `NOT_FOUND`.
- Search and graph reads use only `KnowledgeGeneration.status = "active"`.
  A rebuild supersedes older building generations, writes a fresh shadow generation,
  and activates it atomically;
  keep the previous active generation queryable until then. AI rebuilds require
  live extraction and embedding routes. Completed non-retryable failures permit
  activation with degraded readiness; configuration-blocked builds terminate.
- Entity identity never crosses projects or generations. `EntityMention` and
  `RelationEvidence` retain logical `documentId`, `sourceChunkId`, and
  `sourceCommitSha` without FKs to rebuildable chunks/documents. Invalidate
  temporal evidence on supersession/deletion; source links still require a
  live same-project document.
- `DocumentSearchChunk.searchVector` is a database-generated `simple`
  tsvector over the chunk's heading path (document title plus headings, joined
  by the immutable `weaver_join_text_array` SQL function) and its body, so a
  document is found by a word of its title without an exact-title match. Title
  occupies its own slot independently of Markdown H1–H6 levels; an identical
  leading title/H1 is deduplicated. Section navigation still uses the body's
  canonical anchor. The
  global search query runs with `staleTime: 0`; index jobs land seconds after a
  save and a cached miss must not outlive them.
- Prisma does not own the `vector`/`tsvector` columns. Use parameterized
  `Prisma.sql`; serialize application vectors with `pgvector.toSql`, cast both
  operands through `embeddingVectorType(size)` (`vector(n)` ≤ 2,000,
  `halfvec(n)` above; migration-created partial HNSW indexes exist for
  256/384/512/768/1024/1536/2048/2560/3072/4000, other sizes scan exactly), and
  require matching project, active generation, model, dimensions, owner type,
  and embedding-route identity. Never use unsafe interpolation for vectors or
  identifiers.

## Jobs and access

- The web runtime publishes durable knowledge jobs through
  `packages/core/src/jobs/publisher.ts` but never registers consumers.
  `apps/agent-worker` is the only runtime that starts the handlers and
  scheduled reconciliation in `packages/core/src/jobs/runtime.ts`.
- Queue payloads contain only canonical project/source/generation IDs, exact
  Git SHAs, paths-at-SHA, and configuration fingerprints. Never enqueue bodies,
  rows, prompts, provider responses, credentials, or client-supplied source
  identities. Enqueue after the Git/DB commit; reconciliation repairs misses.
- Viewer+ may search, inspect graph data/provenance, and read
  `knowledge.readiness` and one document's `knowledge.document` details
  (`services/knowledgeDocument.ts`; embedding and extraction model names stay
  `null` below Maintainer). Maintainer+ may read `knowledge.status`, rebuild, and
  retry. Roles come only from project membership; global Admin grants no
  project role or membership bypass (see `weaver-auth`). Members below a visible
  operation's role receive `FORBIDDEN`; nonmembers receive `NOT_FOUND`.
- Provider output is untrusted: validate shape, sizes, confidence, temporal
  values, PostgreSQL usage ranges, and exact finite/nonzero float32 vector
  dimensions before persistence, cache reuse, or queries. Rejections throw
  `validationError(message, usage, details)`; `details` is safe metadata (stage,
  counts, `describeExtractionIssues` paths/codes, finish reason) that `withUsage` and
  `callExtraction` preserve, `classifyProcessingFailure` appends to the stored failure
  summary, and `knowledge.document.failed` records as `details.validation`. Stream provider
  responses through the 8 MiB cap; do not materialize an unbounded body.
  Re-check the live SHA before atomic publication. Log/store safe metadata
  only, never source text, prompts, keys, or provider bodies.
- A rejected extraction gets exactly one correction turn. Both adapters run
  `extract` through `extractWithCorrection` (`packages/core/src/ai/http.ts`): when
  `parseExtractionJson` rejects the content at stage `json`, `schema`, or `temporal`,
  the adapter replays the same request plus the model's response as an assistant
  turn and `extractionCorrectionMessage` (the `path: code message` issues) as a
  user turn, then parses the second answer. Provider text never leaves the
  adapter closure. Envelope failures and truncated responses (`length` /
  `max_tokens`) are not re-asked. The result's usage is the sum of both calls
  and `correction` makes `callExtraction` emit `knowledge.extraction.corrected`
  (warn). A second rejection stays a terminal validation failure with
  `correction: "rejected"`, `initialStage`, and `initialIssues`; a failed
  correction call rethrows the first rejection with `correction: "failed"`, and
  a cancellation during it rethrows the first rejection carrying both calls'
  known usage so every completed call is still accounted. The correction
  wording is outside the configuration fingerprint because it never changes an
  accepted first response;
  changing it needs no `KNOWLEDGE_PROMPT_VERSION` bump.
- `EXTRACTION_SYSTEM_MESSAGE` (`packages/core/src/ai/http.ts`) is the single
  extraction prompt for every adapter and must spell out each field of
  `extractionResponseSchema` (`http.test.ts` enforces it); a model only sees
  that text, never the zod schema. Any wording change bumps
  `KNOWLEDGE_PROMPT_VERSION` (`packages/core/src/knowledge/config.ts`), which
  feeds the extraction fingerprint; it never forces a rebuild.
- Raw SQL writes timestamps with `UTC_NOW` from `services/sql.ts` and sets
  `createdAt` explicitly; `CURRENT_TIMESTAMP`/`now()` store the session time
  zone's wall-clock next to Prisma's UTC values and skew failure ordering.
- Chunk documents through `chunkDocumentSource` (`knowledge/chunkDocument.ts`),
  never `chunkMarkdown` directly: it dispatches on `DocumentIndexSource.kind`
  (`body` holds Markdown or Python text). Python chunks follow top-level
  `def`/`class` groups (`chunkPython.ts`, `documents/pythonOutline.ts`), split
  oversized groups into whole-line windows, and have no navigation anchor.
- Knowledge chunks are deterministic and hard-capped at 9,000 characters and
  256 per document. Extraction envelopes are at most 64,000 characters;
  embedding batches must fit the exact serialized 128 KiB provider request
  body (including JSON escaping and the model envelope) through the shared
  `ai/embeddingBatches.ts` helper for both documents and entities. The helper is
  lazy and reads `AiProvider.embeddingCharacterBudget` before every request: the
  knowledge provider's `ai/embeddingPacer.ts` sends one input until it has measured
  the embedding connection, then fills half its timeout at the averaged
  characters-per-second rate and halves that rate after a timeout, so slow CPU
  models stay inside the timeout while fast providers keep 32-input batches; heading paths are six
  200-character components. Public search additionally
  returns at most twenty 200-character aliases.
- Extraction limits apply per response (50 entities / 100 relations). Publication
  admits at most 500 distinct entities, 2,000 mentions, and 1,000 relations per
  document; excess items are dropped without failing the generation.
- Documents whose chunks are identical after a commit (a move, a header rewrite, a metadata change) reuse completed compatible generation results through
  `services/knowledgeMoves.ts`. Keyword sync compares the complete chunk projection
  (content, hashes, anchors, heading paths), remaps live evidence to new SHA-derived chunk IDs, and advances ready
  semantic/graph SHAs without changing attempt counts or historical evidence. Changed
  files, incomplete chunks/vectors, and unfinished generations follow normal processing.
  Reconciliation and building-generation resume defer reusable target changes until
  keyword sync completes. Carry-forward refreshes canonical descriptions and counters
  using persisted state contributions so pending source changes are not deducted twice.
- Keyword sync copies compatible unchanged-content vectors to new SHA-derived chunk IDs before transactionally removing obsolete chunks and vectors. No unbounded orphan cache is retained. Heading-only and trailing empty sections emit bounded chunks with canonical anchors. Git source checks verify actual ancestry; absent paths return null, operational Git failures propagate for retry.
- Entity candidate scans filter normalized types before their cap and refuse alias resolution from incomplete scans. EntityMention.sourceDescription retains source provenance; canonical descriptions choose highest-confidence current-SHA evidence with deterministic document/text ties. Publication and deletion refresh affected entities in 200-row pages and invalidate vectors when descriptions change. Legacy summaries have no fabricated provenance and refresh when touched or rebuilt.
- Keyword sync removes obsolete chunks and their embeddings transactionally; deletion
  also prunes orphan chunk embeddings. Embedding publication sets semantic readiness
  independently of graph extraction; semantic search checks that SHA, not graph status.
  Project `knowledge.readiness` follows the same rule: a failed generation document
  degrades only the layers whose indexed SHA is not HEAD (`semanticFailed`/`graphFailed`
  in `loadKnowledgeReadiness`), so an embedded document with a failed extraction keeps
  semantic ready and matches its per-document index lights.
- Keyword sync records terminal validation/source failures, exposes them in status,
  and skips their automatic redelivery until the SHA changes or a Maintainer retries.
  The retry cursor reserves `00000000-0000-4000-8000-000000000000` for keyword pages
  before generation pages, sharing the 200-item budget. Same-SHA repair deletes
  obsolete chunk identities before upsert. Enrichment alone may skip an already-ready
  SHA with live chunks; explicit keyword-sync deliveries always rebuild the projection.
- `services/knowledgeTargets.ts` owns the shared live-project lock and generation /
  source predicate. Keyword readiness is required for graph publication, while
  embedding preparation uses the same predicate without that additional join.
- Generation snapshot/resume/configuration-blocking and failed retry use stable
  200-row cursors, bulk SQL, and identifier-only continuations. Counters use
  concurrency-safe transition deltas plus aggregate SQL only at page/terminal
  boundaries; readiness and activation never materialize a whole project.
- Reconciliation repairs missing/mismatched generation targets through
  `recordDocumentChangeForGenerations` before enrichment, independently checks
  completed building generations even beside a compatible active one, and
  activates empty replacements too. Already-ready document redelivery retries
  activation after a failed readiness-to-activation handoff.
- Migration `20260912000100_repair_document_keyword_projection` invalidates
  ready keyword state so scheduled reconciliation rebuilds legacy H1 headings
  and chunks lost by the former document-index replacement.
- Knowledge writers share `knowledgeTransaction` (120 s timeout / 10 s pool wait),
  acquiring the project `FOR NO KEY UPDATE` lock before generation/document rows; FK inserts remain unblocked. Finished failed
  generations expire after seven days. Native job payloads are validated before
  diagnostic context or handler execution; invalid deliveries are acknowledged safely.
- Enrichment admits six attempts per source revision/manual retry, then completes
  the failure for degraded activation. Keyword terminal kinds propagate to the
  generation before any provider work.
- General jobs expire after 15 minutes; system reconciliation has a 60-minute lease. `document.ai-enrich` runs with local
  provider concurrency one, propagates pg-boss cancellation through every AI
  call, and uses a 24-hour lease (pg-boss's maximum). Paced embedding requests make
  the call count unbounded, so `processGenerationDocument` aborts its provider calls
  at `KNOWLEDGE_ENRICHMENT_DEADLINE_MS` (23 h) and records a retryable `provider`
  failure ("AI enrichment exceeded its time budget"); job cancellation stays a
  cancellation. `jobs/queue.test.ts` pins deadline + one 120-second call < lease.
  Each embedded document emits `knowledge.document.embedded` (info) with chunk,
  request, largest-request, character, duration and next character-budget counts. `project.reconcile` and `document.search-sync` use
  short-policy queues with canonical singleton keys. Reconciliation honors cancellation
  at page boundaries; retry/expiry drift updates queued enrichment jobs without
  refusing startup or altering active job leases.

## LLM routing and generation identity

- `resolveKnowledgeRouting` resolves the live `knowledge_extraction` and
  `knowledge_embedding` routes. Worker handlers receive a
  `KnowledgeRoutingSource`; `createKnowledgeRoutingSource` resolves the route
  and creates providers without exposing credentials to knowledge services.
  A cached job-route fingerprint mismatch must be rechecked through the
  source's uncached `resolveFresh` before a generation is configuration-blocked.
- `knowledgeAiIdentity` is the single translation from resolved routing into
  generation/job identity. `routeSnapshot` stores the non-secret extraction
  and embedding connection/model snapshot for AI-routed generations and is
  null for keyword-only generations. It is historical/audit data, not a
  credential or usage lookup source; runtime calls resolve live connections.
- The index fingerprint (`configFingerprint`) is `knowledgeIndexFingerprint`
  over the embedding model's effective vector-space key (`LlmModel.vectorSpaceKey`
  or the default provider-type/endpoint/model/upstream digest), dimensions,
  dimension mode and extraction schema version
  (`packages/core/src/knowledge/identity.ts`; SQL twins in migration
  `20260926090000_knowledge_index_identity`). The extraction route and prompt
  version are per-document provenance
  (`KnowledgeGenerationDocument.extractionFingerprint` / `extractionModel`);
  changing them never creates a generation. Admin saves run through
  `withKnowledgeRoutingChange` and queue `project.reconcile` for live projects
  when the index fingerprint changes. These deliberately exclude connection
  IDs/names, credentials, prices, and timeouts so an equivalent recreated
  connection does not force a rebuild.
- Knowledge vectors have the routed embedding model's size, any integer from 1
  to 4,000 (`knowledge/dimensions.ts`). Native models must return that exact
  size; Matryoshka models are finalized to it before persistence, cache reuse,
  or vector queries.
- Embedding reuse loads all chunk hashes in one query, supported by the
  `(projectId, ownerType, contentHash)` index. Semantic document retrieval bounds an
  index-eligible nearest-embedding stage before document deduplication. Graph entities
  require a non-invalidated mention on read; historical evidence remains stored.
- Semantic search embeds with the live knowledge-embedding route, then
  selects active generations whose fingerprint equals the live one. No
  compatible rows means keyword fallback with
  `semantic_unavailable`. The query embedding waits at most
  `QUERY_EMBEDDING_TIMEOUT_MS` (5 s) so a search queued behind indexing on a slow
  local model degrades to keyword results instead of hanging, emitting a
  `knowledge.search.degraded` warning with `reason` (`timeout`/`provider`/
  `validation`), `timeoutMs` and `durationMs` — never the query text.
- Integration tests use `seedTestLlmRouting`, `fakeRoutingSource`, and
  `noKnowledgeRouting` from `apps/web/tests/integration/_harness.ts`; never
  recreate route fixtures or decrypt credentials inside a knowledge spec.

## Graph carry-forward

`ensureGenerationForCurrentConfig` copies the active generation's graph into a new generation when both share the extraction schema version and the source has a route snapshot (`knowledgeCarryForward.ts`): entities (with a disambiguation suffix rewritten to the new id), aliases, relations, all mentions and evidence including invalidated history, and `KnowledgeGenerationDocument` rows that are `ready` with `graphIndexedSha` equal to the live head — as `pending` with the extraction fingerprint/model kept and `semanticIndexedSha` null. Vectors are never copied. `KnowledgeGeneration.graphSourceGenerationId` records the source (no FK). A carried document's job embeds its chunks, then `embedDocumentEntities` embeds the entities it mentions at its SHA that lack a vector (`ON CONFLICT DO NOTHING`), so it becomes ready only with its entity vectors. Manual rebuilds and schema-version changes never carry; carry-forward is also skipped when the new generation supersedes a building generation that was re-extracting (no `graphSourceGenerationId`), so a pending manual Rebuild still re-extracts fully. Entity resolution never reads vectors — keep it that way or carry-forward becomes invalid.

## Graph route and URL state

- `/projects/[projectId]/graph` is an authenticated full-height workspace.
  `apps/web/src/lib/knowledge/graphUrl.ts` is the only parse/serialize boundary: validate
  UUIDs, trim/deduplicate/sort repeated filters, cap projects at 50 and type
  filters at 20, let a valid focus win over a document seed, and omit the lone
  route project from canonical URLs.
- The route awaits both Next `params` and `searchParams`, then passes bounded
  `GraphUrlState` into the client. Global entity results use `graphHref` rather
  than assembling query strings independently.
- Viewer onboarding calls only `project.get` and `knowledge.readiness` for the
  route project. Access failures replace cached names with a nonsensitive
  not-found state; transient failures are retryable. Readiness copy may explain
  keyword-only operation but never exposes provider names, credentials, or
  Maintainer-only status.

## Graph explorer presentation state

- `apps/web/src/lib/knowledge/graphState.ts` is the authoritative client accumulator.
  It locates focus by canonical ID, admits only that entity's project, dedupes
  nodes/relations by ID, retains only edges with admitted endpoints, and never
  exceeds 100 nodes or 200 edges. Focus is the only reset path; later expansion
  may merge unseen same-project items without evicting existing ones.
- `GraphScreen` owns API snapshots and response identities. Focus and document
  seed queries are mutually exclusive; URL filters remain authoritative. A
  filter or focus change clears selection and the presented neighborhood before
  navigation, while access/auth errors replace cached graph data. Cross-project
  focus navigation intersects retained scope with a fresh accessible-project
  list before serializing the destination. A direct focus response owned by a
  different project is likewise gated on a fresh accessible-project list and
  canonically replaces the route before any canvas data renders.
- `GraphOutline` is a complete semantic read surface, not a canvas fallback
  assembled from DOM state. Nodes are focus-first then name/ID ordered;
  relations are source-name/type/target-name/ID ordered. Selection uses the
  same canonical IDs later shared with the canvas and every loaded item remains
  keyboard actionable.
- `GraphCanvas` is a browser-only enhancement: Cytoscape is dynamically
  imported inside its client effect, disposed on focus change/unmount, and
  receives only deterministic plain elements from `graphPresentation.ts`.
  React remains authoritative for elements and selection; reconcile element
  changes separately so expansion preserves pan/zoom, refresh styles from CSS
  tokens when the root theme changes, and keep `GraphOutline` visible on canvas
  load failure.
- Size the Cytoscape host with `h-full w-full` inside its fixed-height wrapper.
  Cytoscape injects an unlayered `position: relative` rule, which overrides
  Tailwind's layered `absolute` utility and collapses an inset-only host to zero height.
- `lib/knowledge/graphCanvas.ts` owns label-aware COSE spacing, theme styles,
  and the centered Fit viewport capped at natural scale. Split alpha-bearing
  fill tokens into a Cytoscape-supported color and `background-opacity`;
  production CSS may serialize rgba as unsupported four/eight-digit hex.
  Keep selected node sizing separate from selected edge width.
- Expand only the selected same-project entity, only while
  `remainingGraphCapacity` shows node and edge room, and with one current
  request identity. Request the full canvas bounds from `graphExpansionBounds`
  (100/200), never the remaining capacity: the server's `maxNodes`/`maxEdges`
  size the whole deterministic response with no exclusion, and
  `mergeGraphNeighborhood` dedupes and caps. Ignore late responses, retain the
  graph and selection on transient failure, and offer Retry. Focus resets via
  the canonical URL, Reset rebuilds the current focus without changing filters,
  and Fit changes only the Cytoscape viewport.
- `GraphScreen` enables exactly one entity/relation detail query from the
  shared React selection and discards identity-mismatched or access-hiding
  results. `GraphDetails` renders only bounded server fields and uses
  `graphCitationPresentation` for live current-document links; citations whose
  live same-project navigation join is absent remain plain text.
- Detail `NOT_FOUND` invalidates the whole graph only when it belongs to the
  current focus; a missing neighbor/relation clears only that selection.
  `FORBIDDEN`/`UNAUTHORIZED` replace cached graph access, while transient detail
  failures remain local. Detail-surface Expand uses the same authoritative
  capacity and pending-action availability as the toolbar and outline.
- Wide graph layouts fill the available workspace width and keep canvas and outline beside a fixed-width collapsible detail rail.
  Narrow layouts keep the outline first and reuse the same filter, selection,
  and detail props in Dialog drawers. Keyboard-requested details may focus the
  detail heading; pointer selection does not, and closing details returns focus
  to a connected selected outline control or the workspace fallback without
  clearing graph state. Crossing to the wide breakpoint closes both mobile-only
  drawers before their hidden overlays can retain modal focus.
- A missing focused entity still leaves finder results actionable. Finder typing
  preserves selection; navigation clears pending expand/reset identities. Retrying
  queries show fetching feedback, and selection and transient loading use separate
  live regions. Keyboard detail requests reopen a collapsed desktop rail.
- `GraphWorkspace` focuses the labeled region after each resolved focus or
  document destination identity, including same-project navigation. Filter-only
  URL replacements retain that identity, finder input, component state, and
  current focus.

## Maintainer operations UI

- Project settings computes the canonical `canRebuild` composition and mounts
  `KnowledgeIndexCard` only for members with Maintainer+ access. Lower roles must not
  mount the card or issue its Maintainer-only status query.
- Every `knowledge.status` failure carries `occurredAt` (its completion time,
  else its last update); render it for each entry so blocked-configuration
  rows are dated too.
- Retain an accepted status snapshot across transient refresh failures, but
  replace it after `NOT_FOUND`, `FORBIDDEN`, or `UNAUTHORIZED`. Poll every
  three seconds while the accepted status contains a building generation or
  any readiness layer is `building`; the latter covers the interval before a
  reconciliation generation row appears. Format timestamps only after
  `useMounted()`.
- Rebuild and failed retry use separate non-dismissible pending confirmations,
  separate pending controls, inline mutation errors, and exact-project status
  plus readiness invalidation. Keep accepted operation receipts independent of
  later query refresh errors.
- Drive retry pages through `runFailedKnowledgeRetry`; zero accepted work, a
  missing continuation cursor, or a repeated cursor is a persistent stalled
  outcome with an explicit manual Retry action.

## Key paths and verification

- Models/migration: `packages/db/prisma/schema.prisma`,
  `packages/db/prisma/migrations/20260829162933_knowledge_index/migration.sql`.
- Services: `packages/core/src/services/{search,graph,knowledge,knowledge*}.ts`;
  provider/runtime: `packages/core/src/{ai,jobs}/`; publisher-only web hook:
  `apps/web/src/instrumentation.ts`; worker composition:
  `apps/agent-worker/src/index.ts`; APIs:
  `apps/web/src/server/api/{routers,schemas}/{search,graph,knowledge}.ts`.
- UI routes:
  `apps/web/src/app/(workspace)/projects/[projectId]/{graph,settings}/`;
  graph URL boundary: `apps/web/src/lib/knowledge/graphUrl.ts`;
  failed-retry driver: `apps/web/src/lib/knowledge/operations.ts`.
- `apps/web/tests/e2e/mock-ai-server.mjs` is the deterministic browser provider: the
  exact trimmed `keyword-only` query returns 503, while the first extraction
  chunk containing `retry-once` returns 400 and succeeds on manual retry. Four
  explicit, content-checked `weaver-capacity:*` profiles each stay within the
  extraction contract and combine through UI-created documents to produce a
  server-truncated neighborhood and the 200-relation canvas cap.
  `apps/web/tests/e2e/knowledge-ui.spec.ts` is the serial, UI-created Phase 3 workflow.
- Validate `.env.test` is `weaver_test` + `./data-test`, migrate if needed,
  then run one affected spec while iterating. Before handing off a completed
  knowledge-index change, **required:** `pnpm test:integration:knowledge` plus
  `pnpm test` when knowledge utilities changed and `pnpm check`. The area set
  is authorized Tier 2; Tier 3 remains consent-gated.
- After fresh Tier 3 consent, validate `.env.e2e` is exactly
  `/weaver_e2e ./data-e2e`, migrate it, then run
  `RUN_FULL_TESTS=1 pnpm e2e apps/web/tests/e2e/knowledge-ui.spec.ts`.

## Background-work read model

Phase 6B background-work visibility exposes generation-level status only to project Maintainers. The read adapter aggregates current generation-document readiness: active generations with pending/processing documents remain queued/running. Keyword-only projection work stays outside this surface. See weaver-jobs.

`KnowledgeGeneration.buildTrigger` (`initial | embedding_change | index_upgrade | manual_rebuild`) records why a generation was built; `requestedById` records who asked, set for `manual_rebuild` (the actor calling `requestKnowledgeRebuild`) and for `embedding_change` (the admin attributed by `generationAttribution` in `knowledgeGenerations.ts`, matched from `knowledge.lastRoutingChange` within 24 hours of the same index fingerprint; null when that account no longer exists). `withKnowledgeRoutingChange` writes that record whenever a save leaves routing available under a new fingerprint, including clear-then-set and re-enabling. Any other new generation with a prior active generation is `index_upgrade` with no requester; the very first generation for a project is `initial`. `services/backgroundWork/knowledgeSource.ts` titles Project-work rows by trigger — "Knowledge index rebuild: embedding model changed" / "…: requested" / "…: Weaver upgrade" — or, for an active generation with pending/processing documents, "Knowledge index: updating N documents"; a personal (`mine`) row for the requester keeps the trigger title regardless of document counts. Its `revision` is derived (`md5` of kind/id/state/terminal time) rather than stored on `KnowledgeGeneration`, and goes through the same `BackgroundWorkReceipt` acknowledgement path as tasks/imports.

## Usage accounting on cancellation

When `embedGenerationDocument` or `enrichGenerationDocument` is aborted — by
cancellation or by the enrichment deadline, which arrives as the same signal —
it flushes every provider call whose usage is already known as
`stale_discarded` through a best-effort `cancelWithUsage`, then rethrows the
AbortError. It never writes a synthetic row for the call that was in flight and
never passes the abort signal to the accounting write. Record a completed
call's usage before checking the signal, not after.

## Entity vectors follow the canonical description

`refreshEntityDescriptions` deletes an entity's vector when its selected
description changes, and an enrichment only re-embeds the entities of its own
extraction. Every such invalidation is repaired without re-extraction:
`repairMissingEntityEmbeddings` (`knowledgeEnrichment.ts`) finds entities of
the generation with a live mention and no `entity` embedding (at most 200 per
pass), rebuilds their canonical text from the stored entity and aliases, embeds
them, re-checks the text inside the write transaction, and records usage.
`processGenerationDocument` runs it best effort after a successful enrichment
and when a job finds its document already up to date; it never fails a ready
document. `reconcileProjectKnowledge` makes no provider calls: per generation
it looks for one orphaned entity with a ready, exact supporting document and
enqueues `document.ai-enrich` for that document, whose up-to-date path runs
the repair. Anything new that deletes entity vectors must leave the entity
detectable by that query.

## Review repair invariants

- Deleted generation-document tombstones (`missing`) are excluded from orphan reconciliation; `content.delete` uses a short queue and a source-type/ID/SHA singleton.
- A restored route reopens blocked documents only in a live generation matching the freshly resolved full fingerprint. Completed incompatible generations remain terminal.
- Resolution races retain staged vectors by content hash; exhaustion is a retryable internal failure. Description drift does not invalidate entity identity resolution, and publication skips any vector whose staged text no longer matches the final canonical description. Post-publication repair uses no expired processing claim.
- Terminal document failures invalidate older-SHA mentions/evidence and refresh canonical descriptions. Graph citation excerpts are explicitly labeled model-generated summaries, including historical rows.
- Semantic queries use transaction-local HNSW iterative strict ordering and `ef_search=100`. Lexical ranking/windows operate on at most 2,000 live matching chunk candidates. Entity and alias generated tsvectors have GIN indexes; bounded entity candidates retain a separate exact-name/alias path.

## Review hardening invariants

A ready row with both indexed SHAs matching its source may enter tokenless entity-vector repair. Repair clears stale ready claims, preserving fresh claim fencing. Missing document tombstones are not background-work failures.

## Wiki lint read model

`listMissingEntityPages` (`services/wikiReads.ts`) joins `GraphEntity`, `EntityMention` and `Document` for the active generation only (`KnowledgeGeneration.status = 'active'`, mentions not invalidated, source pages not counted) and lists entities named in at least three pages whose normalized name or alias matches no page title. It is a read for the wiki agent's lint run, bounded to 25 per page with a keyset cursor, and never writes the graph. See `weaver-wiki`.
