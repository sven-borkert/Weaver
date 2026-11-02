---
name: weaver-admin
description: Use when changing Weaver administration, LLM connections/models/provider adapters and routing, embedding compatibility, provider trust/cache behavior, global users, admin control tools, or outbound MCP transport/catalog internals.
---

# Weaver Admin

Phase 4C implemented encrypted LLM connections, declared models, connection
and model tests, and purpose routing. Admin diagnostics adds its settings page
and MCP-only tools. Phase 5B activates the `ingestion` purpose ("Import
parsing") and adds a **Document parsing** card for an optional docling-serve
endpoint. Phase 7 scope pulled forward, ahead of Phase 6, added global user
management: Administration › Users (see below). Phase 6A activates the
`jobs` purpose, labeled **Scheduled tasks**, routing scheduled AI task runs
(`weaver-scheduled-tasks`). External data sources, broader system statistics,
backup/restore, and global user API-key administration remain Phase 7.
The optional `document_summary` purpose supplies short comments for direct document
saves; it does not use the assistant or scheduled-task runtime.

Project lifecycle and personal workspaces use `weaver-projects`; dashboard/pins use `weaver-dashboard`. Peer OAuth connections and content transfer use `weaver-remote-instances`. Keep provider adapters, model discovery and routing under this skill.

## Key files

| Path                                                     | Role                                                                                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/services/llmConnections.ts`           | Admin authorization, connection/model CRUD, write-only credentials, tests, startup coverage, and rotation                                                          |
| `packages/core/src/services/llmRoutes.ts`                | Active purposes, health, route mutations, snapshots, and 15-second cache                                                                                           |
| `packages/core/src/services/documentChangeSummaries.ts`  | Background document change comments: queue on save, worker job, reconcile                                                                                          |
| `packages/core/src/services/ingestionSettings.ts`        | Docling base URL/timeout setting (cached), connection probe (`GET /health`)                                                                                        |
| `packages/core/src/services/llmRouteCache.ts`            | Process-local route-cache revision invalidation                                                                                                                    |
| `packages/core/src/ai/adapter.ts`                        | Provider-neutral adapter contract                                                                                                                                  |
| `packages/core/src/ai/embeddingDimensions.ts`            | Native/Matryoshka embedding-vector finalization                                                                                                                    |
| `packages/core/src/ai/adapters.ts`                       | Provider selection and fixed hosted endpoints                                                                                                                      |
| `packages/core/src/ai/openaiCompatible.ts`               | OpenAI and OpenAI-compatible adapter                                                                                                                               |
| `packages/core/src/ai/openrouter.ts`                     | Bounded, model-specific OpenRouter upstream-provider discovery                                                                                                     |
| `packages/core/src/ai/anthropic.ts`                      | Anthropic adapter                                                                                                                                                  |
| `packages/core/src/ai/lmStudio.ts`                       | LM Studio adapter: `/v1` calls plus native `/api/v0/models` discovery                                                                                              |
| `packages/core/src/ai/ollama.ts`                         | Ollama adapter: `/v1` calls plus `/api/tags` + bounded `/api/show` discovery                                                                                       |
| `packages/core/src/ai/modelDiscovery.ts`                 | `DiscoveredModel` finalization: catalog fill, capability defaults, bounds, `source`, LiteLLM `/model/info` merge                                                   |
| `packages/core/src/ai/modelCatalog.ts`                   | Static limits for hosted OpenAI/Anthropic families (fallback only)                                                                                                 |
| `packages/core/src/ai/registry.ts`                       | Credential sources and snapshot-to-adapter composition                                                                                                             |
| `packages/core/src/ai/http.ts`                           | Bounded provider HTTP helpers                                                                                                                                      |
| `packages/core/src/security/encryption.ts`               | AES-256-GCM encryption, AAD, and key-version checks                                                                                                                |
| `packages/config/src/encryptionKeys.ts`                  | `WEAVER_ENCRYPTION_KEYS` parser and active-key selection                                                                                                           |
| `apps/web/src/server/api/routers/llm.ts`                 | `adminProcedure` tRPC adapter                                                                                                                                      |
| `packages/core/src/services/llmSchemas.ts`               | Shared LLM input schemas; web schema module re-exports them                                                                                                        |
| `apps/web/src/app/(workspace)/admin/`                    | Admin-only layout and Administration › Settings › AI UI (`ImportModelsDialog` declares discovered models in bulk; `DocumentParsingCard` holds the Docling setting) |
| `packages/ai/src/model.ts`                               | Assistant and scheduled-task provider models; forwards OpenRouter provider pins and route thinking effort                                                          |
| `packages/core/scripts/rotate-secrets.ts`                | `pnpm secrets:rotate` entry point                                                                                                                                  |
| `packages/core/src/services/diagnosticsSettings.ts`      | Diagnostics setting/cache and table statistics                                                                                                                     |
| `packages/core/src/services/diagnosticEvents.ts`         | Diagnostic queries and advisory-locked housekeeping                                                                                                                |
| `packages/assistant-tools/src/tools/admin/`              | MCP-only `system:admin` contracts                                                                                                                                  |
| `apps/web/src/app/(workspace)/admin/diagnostics/`        | Administration › Diagnostics UI                                                                                                                                    |
| `packages/core/src/services/remoteInstances/registry.ts` | Remote instance registry CRUD, Test, and peer OAuth client sync (`weaver-admin`)                                                                                   |
| `apps/web/src/app/(workspace)/admin/remote-instances/`   | Administration › Settings › Remote Instances UI                                                                                                                    |

## User administration

Phase 7 scope pulled forward, ahead of Phase 6.

| Path                                             | Role                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/services/users.ts`            | `assertSystemAdmin`; list/get/create/setRole/deactivate/reactivate/resetPassword/revokeSessions/setUserMembership; last-Admin and self-action guards                                                                                                                                              |
| `packages/core/src/services/userSchemas.ts`      | Shared zod inputs (`PASSWORD_MIN_LENGTH = 12`); web schema module re-exports them                                                                                                                                                                                                                 |
| `packages/auth/src/adminUsers.ts`                | `createUserAdministrator(auth)` — the Better Auth admin-plugin port; see `weaver-auth` for which of its six operations reach the plugin as a trusted server call versus `internalAdapter` primitives                                                                                              |
| `packages/auth/src/passwordChange.ts`            | `createPasswordChanger(auth)` — self-service `/change-password` port                                                                                                                                                                                                                              |
| `apps/web/src/server/api/routers/user.ts`        | `adminProcedure` tRPC adapter                                                                                                                                                                                                                                                                     |
| `apps/web/src/app/(workspace)/admin/users/`      | Administration › Users: list with create + one-time password reveal, and the `[userId]` detail route (Account/Access/Memberships cards)                                                                                                                                                           |
| `apps/web/src/app/(workspace)/admin/projects/`   | Administration › Projects: metadata-only list of every project (`adminProject` router, `packages/core/src/services/adminProjects.ts`) and the `[adminProjectId]` detail route whose Members card writes through `user.setMembership`; the param is not `projectId` so workspace chrome ignores it |
| `apps/web/src/app/(workspace)/account/password/` | Self-service password page, reached by a forced redirect while `mustChangePassword` is set                                                                                                                                                                                                        |

An Admin cannot deactivate or demote themselves, reset their own password
through this surface, or grant, change, or remove their own project
membership; the set of
active Admins (`role = Admin, banned = false`) can never reach zero
(`lockGlobalAdminRoster`, contended by both the role-change and deactivation
paths). `setUserMembership` acts with Admin authority — it skips
`assertProjectRole` so an Admin can restore access to an orphaned project —
but refuses outright when the target is the acting Admin; see `weaver-auth`
— that single guard is an accountability control, not a containment one: an
Admin can still reach project content by puppeting a new user as Owner or
resetting an existing Owner's password and signing in as them, but only by
leaving an attributable administrative trail, never a silent self-grant.
Password creation keeps the one-time reveal in the create dialog until Done;
reset uses `RevealPasswordDialog`, sharing `RevealPasswordContent` (copy/select).
Closing clears the plaintext and resets the mutation with `gcTime: 0`.
Account › API keys includes `McpSetupHelp` with the configured MCP resource URL,
copyable client instructions and documentation links; examples use placeholders
and never collect or retain a real key in the help component.
A reset also revokes the user's API keys and
OAuth grants in the same transaction that sets `mustChangePassword` —
containment, not suspension; see `weaver-auth` — and the Access card's dialog
states it. Seven `admin.user.*` diagnostic events cover every
mutation without ever logging a password. User deletion is not offered;
removal is deactivation, enforced as a complete kill switch by the shared auth
hook and `packages/core/src/security/bearer.ts`.

## Insight services

| Path under `packages/core/src/services/` | Responsibility                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `adminOverview.ts`                       | Allowlisted MCP runtime facts, table sizes and health                                  |
| `queueInspection.ts`                     | Parameterized pg-boss inspection, including absent-schema handling                     |
| `aiUsageQueries.ts`                      | Filtered usage rows and grouped totals                                                 |
| `knowledgeInspection.ts`                 | Scoped Maintainer inspection of generations and document states                        |
| `ingestionInspection.ts`                 | Scoped Maintainer inspection of import batches, files, and drafts                      |
| `scheduledTaskInspection.ts`             | Task definitions and run diagnostics; Maintainer output access and scoped source reads |
| `assistantInspection.ts`                 | Assistant run metadata and reduced event metadata                                      |
| `mcpAuditQueries.ts`                     | Payload-free MCP audit rows                                                            |
| `documentChangeSummaryInspection.ts`     | Metadata-only change summary rows, per-status counts, and project facets               |
| `adminPaging.ts`                         | Canonical cursors and bounded list limits                                              |

pg-boss inspection follows the `weaver-database` raw `timestamptz` convention:
UTC projections for returned dates, and ISO strings cast to `timestamptz`
for instant filters and cursors. Millisecond truncation must match the queue
list's sort key and cursor comparison.

Assistant run tools return metadata only: never conversation text, message text,
provider bodies, provider error prose, or event/tool payloads. Every insight list accepts `limit` and
`cursor`; `tools/admin/paging.ts` budgets the complete envelope and derives
continuation from the last emitted row. Knowledge tools check scope before
service access and require project Maintainer membership, including for Admins.
Connection model previews carry `modelsTruncated`; use `list_llm_models` to page
through the full inventory. Usage integers beyond JavaScript's exact range are
returned as decimal strings. Status/detail arrays report truncation while
preserving their enclosing metadata.

## Control tools

LLM write contracts in `tools/admin/llmWrite.ts` use the same schemas and core
services as the tRPC router. `ToolContext.llm` supplies `{ ring, fetchImpl }`
from the MCP server; tests inject provider HTTP fakes. Never resolve secrets
inside a contract or return credentials. Knowledge writes retain scope,
Maintainer membership, and `content:write` checks; reconciliation authorization
belongs in `adminKnowledgeReconciliation.ts`. All writes await their actual result.

## Conventions

- Every admin-facing service starts by calling `assertSystemAdmin` for
  system-wide diagnostics/operations or `assertLlmAdmin` for LLM CRUD,
  connection/model tests, and routes. `system:admin` implies `llm:admin`, never
  the reverse. The router's
  `adminProcedure` is defense in depth, not a replacement for the service
  check. Runtime/internal decrypt, startup coverage, and rotation helpers have
  no actor and are intentionally exempt.
- Admin contracts are MCP-only entries in `ADMIN_TOOLS`; never add them to
  `ASSISTANT_TOOLS`. Persist argument names only, never admin argument values.
- Credentials are write-only. Public reads use `CONNECTION_SUMMARY_SELECT`,
  which excludes ciphertext, nonce, tag, and all credential material while
  intentionally exposing `credentialKeyVersion` metadata; never add credential
  material to tRPC output, logs, snapshots, usage, or error summaries.
- Runtime credential resolution intentionally reads and decrypts the live row
  for every provider call, atomically checking the expected endpoint, provider,
  and enabled state before decrypting. Obsolete adapters fail before HTTP;
  rotation at an unchanged destination takes effect immediately.
- OpenAI, Anthropic, and OpenRouter use the fixed endpoints in
  `PROVIDER_FIXED_ENDPOINTS` (`openrouter` is
  `https://openrouter.ai/api/v1`). `openai_compatible`, `lmstudio`, and `ollama`
  accept an admin-supplied HTTP(S) endpoint (reject credentials, fragments,
  and query strings); the two local types default to
  `PROVIDER_DEFAULT_ENDPOINTS`, store the server root (a trailing `/v1` is
  stripped), and adapters append `/v1` themselves.
- The credential is optional only for `lmstudio`/`ollama`
  (`isCredentialOptional`): an empty credential is still encrypted and stored,
  and every adapter (core and `packages/ai/src/model.ts`) sends no
  `Authorization` header for it. A blank credential on update still means
  "keep" in the form; when changing a local provider's origin, the explicit
  "Use the new endpoint without an API key" choice sends an empty credential.
  The service treats `null`/omitted as keep and an empty string as keyless.
- `ACTIVE_LLM_PURPOSES` contains `assistant`, `knowledge_extraction`,
  `knowledge_embedding`, `ingestion` ("Import parsing" — required capability
  `chat`; a route additionally needs the `vision` capability before Imports
  will transcribe scans, checked at OCR time, not by
  `REQUIRED_CAPABILITIES`), and `jobs` ("Scheduled tasks" — required
  capability `chat` only, so a cheap local model routes it; every scheduled
  AI task run resolves this route, see `weaver-scheduled-tasks`). Enforce
  `REQUIRED_CAPABILITIES` for each.
- `document_summary` ("Document change summaries") is also active and optional,
  requires only `chat`, and appears neutral when unassigned. A save with the
  route ready queues `document.change-summary`; the worker sends bounded
  title/changed-excerpt input through `AiAdapter.completeText` with the
  connection timeout, records usage as `document.change_summary`, suppresses
  provider bodies, and emits `document.summary.*` events. Explicit API comments
  bypass generation. Keep the same route schemas for the UI and `set_llm_route`
  MCP tool; enum additions require a Prisma migration.
- `wiki` ("Project wiki agent") is active and optional too: it needs `chat` and `tool_use`, shows
  neutral when unassigned, and its card says unassigning it stops every project's agent. The
  per-project setting and runner live in `weaver-wiki`.
- Connection timeouts range 1–120,000 ms (`MAX_REQUEST_TIMEOUT_MS`; the core
  and form schemas repeat the bound). The enrichment lease budget in
  `jobs/queue.test.ts` multiplies it, so raise both together. Knowledge
  embedding requests are paced to half the embedding connection's timeout.
- Invalidate `llmRouteCache` after every connection, model, or route mutation
  that could affect routing or health.
- Model edits lock the model row before reading and merging partial fields so
  concurrent edits preserve independent changes.
- Vector compatibility: `verifyEmbeddingCompatibility` / `clearEmbeddingCompatibility`
  in `services/llmVectorSpace.ts` compare 8 fixed samples at min cosine 0.98
  and share `LlmModel.vectorSpaceKey` (routed model's key wins); identity
  edits clear it. The Routes card confirms knowledge route switches with
  `previewKnowledgeRouteChange`; Remove compatibility confirms a clear that
  reindexes with `previewClearEmbeddingCompatibility`. Both previews are
  fetched with `staleTime: 0` because compatibility can change between
  openings. Verification re-checks both models' identity (and connection
  endpoint) when it writes and fails with `CONFLICT` if either changed.
  MCP `set_embedding_compatibility`.
- Web, worker, and MCP must call `assertConnectionSecretsDecryptable` before starting
  work. A missing key version or failed sample decrypt for any stored version is
  a startup error, not a degraded connection.
- Provider discovery must consume bounded/paginated APIs. Anthropic follows
  `has_more`/`last_id`; Ollama enriches at most `MAX_OLLAMA_SHOW_CALLS` models
  with four concurrent `/api/show` calls (never `verbose`); native LM Studio /
  Ollama calls use `boundedJsonRequest` directly rather than the `/v1`
  wrapper. `listModels` returns `DiscoveredModel`s and `testLlmConnection`
  runs them through `finalizeDiscoveredModels` (endpoint values win over the
  catalog, which never applies to local providers) before capping at
  `MAX_DISCOVERED_MODELS`. Generic OpenAI-compatible discovery recognizes LiteLLM's public `max_input_tokens`, `max_output_tokens`, and `mode` fields and, only for `openai_compatible` (`liteLlmModelInfo` adapter option), also reads `GET /model/info` (`mode`, `supports_function_calling`, `output_vector_size`, limits) through `applyLiteLlmModelInfo`; a failed or non-JSON `/model/info` response leaves the public list untouched, while caller cancellation propagates. Only LiteLLM assertions become capabilities (`mode: embedding`, `supports_function_calling: true`): `mode: chat` alone asserts nothing, `supported_openai_params` is provider-level and ignored, and Weaver never guesses `tool_use` from a model id; the Admin can declare it after import or set it in LiteLLM's `model_info`.
- OpenRouter model edits discover upstream choices through its bounded
  `/models/:author/:slug/endpoints` API. `LlmModel.upstreamProvider` is null for
  Automatic routing or holds one selected provider slug. Send a pin only for
  `openrouter`, as `provider: { only: [slug] }`, through the core adapter's
  completion, probe, and embedding requests and the assistant/task AI SDK path.
  Keep the saved slug selectable if a later discovery response omits it.
- `importLlmModels` is the bulk declaration path: per-row problems become
  `skipped` entries, embedding dimensions are probed (`MAX_IMPORT_PROBES`,
  recorded as `llm_model_import_probe` usage) before the transaction, creates
  use `createMany` + `skipDuplicates`, and `updateExisting` only refreshes
  limits — never names, capabilities, or prices. Imports retain their native
  dimensions and `native` embedding-dimension mode; an Admin must explicitly
  enable Matryoshka only for a declared embedding model trained for safe
  dimension reduction. The shared 60-second probe deadline becomes per-row
  skips while valid rows are retained; record every attempted probe, including
  deadline failures. Accounting uses `recordAiUsageSafely`, so persistence
  failures emit `ai.usage.failed` without discarding valid provider results.
- Ollama's internal discovery deadline becomes a controlled provider timeout;
  caller cancellation still propagates. Connection/model test outcomes emit
  `llm.connection.tested` / `llm.model.tested`; failed import probes emit
  `llm.model.import_probe_failed`, with closed reason metadata only.
- `LlmRoute.reasoningMode` is per purpose and applies to chat calls only: `provider_default`
  sends nothing; `none`/`low`/`medium`/`high` become `reasoning_effort` on
  OpenAI-style adapters (LiteLLM maps it onto DeepSeek's `thinking`), a bounded
  `thinking.budget_tokens` on Anthropic (`anthropicThinkingParams` skips it when
  `max_tokens` leaves no room), and the AI SDK's generic `reasoning` option through
  `createAssistantLanguageModel`'s middleware. Helpers live in `packages/core/src/ai/reasoning.ts`;
  adapters receive the value through `AiCallOptions.reasoning`, never through the
  connection config. It is not part of the knowledge configuration fingerprint, so
  changing it never forces a rebuild. The embedding route stays at
  `provider_default`; the same model may be assigned to several routes with
  different thinking effort. The migration backfills existing route values from
  their assigned model, then normalizes the embedding route to `provider_default`;
  retain `LlmModel.reasoningMode` only for rollout
  compatibility and do not read it for new calls.
- OpenAI chat calls and probes use `max_completion_tokens`; compatible/local
  endpoints use `max_tokens`. Embedding usage has known zero output tokens;
  unknown input remains unknown. A known zero-token side needs no price to
  calculate usage cost.
- Model tests and runtime embedding calls both use the shared finalization
  path: native vectors must be exactly the declared size, while Matryoshka
  vectors may be safely reduced and normalized. Sending the `dimensions`
  request field remains provider-specific: Ollama supports it for Matryoshka,
  OpenAI supports it only for `text-embedding-3`, and LM Studio or generic
  OpenAI-compatible endpoints use the returned vector and shared finalizer.
- Anthropic cache-read and cache-creation tokens are included in total input; only cache-read tokens populate `cachedTokens`; until cache-specific pricing exists, usage cost
  conservatively applies the declared input rate to them.
- Follow the canonical [key rotation procedure](../../../docs/setup.md#rotate-encryption-keys); web, worker, and MCP all hold startup key rings.
- Provider HTTP in tests goes only through injected `fetchImpl`. Router/service
  coverage lives in `apps/web/tests/integration/llm.spec.ts`; browser coverage
  lives in `apps/web/tests/e2e/admin-ai.spec.ts`.
- Any save that changes a live knowledge index identity — `updateLlmModel` on
  the routed embedding model (size, mode, provider model, upstream) or
  `setLlmRoute` switching the embedding route to a different fingerprint —
  first calls `probeKnowledgeEmbedding` (one sample, usage `llm_model_test`)
  and fails `BAD_REQUEST` on the dimensions/model field when the vector size
  is wrong; the write re-checks the probed identity and fails `CONFLICT` if it
  changed. A first assignment (no live routing) is not probed. Both services
  take optional `LlmAdminDeps` as a fourth argument; tRPC passes `deps(ctx)`,
  MCP `llmDeps(ctx)`. `previewKnowledgeModelChange` (`"none" | "reembed"`)
  feeds the model dialog's confirmation step, which locks the form's fields
  while it shows.
- Weaver stores no native embedding size. Unticking "Matryoshka / resizable"
  in the model dialog calls `llm.detectEmbeddingDimensions` (core
  `detectEmbeddingDimensions`: the adapter's `probeEmbeddingDimensions`, no
  size requested, usage `llm_model_test`, `BAD_REQUEST` on
  `embeddingDimensions` when it fails) and fills the returned size; a late
  answer is ignored once Matryoshka is ticked again.

Follow `weaver-auth` for global Admin/capability rules,
`weaver-trpc-routers` for the adapter, `weaver-ui-pages` for the route,
`weaver-env-deploy` for key-ring and runtime ownership, and `weaver-ingestion`
for how the `ingestion` route and Docling setting are consumed by parsing.

## Provider trust and cache scope

Custom endpoints use @weaver/config/outboundFetch: public HTTPS by default, DNS addresses validated and pinned per request, no automatic redirects. Private/HTTP services require an exact origin in WEAVER_OUTBOUND_ALLOWED_ORIGINS (non-production loopback is allowed). Changing a stored LLM origin requires credential re-entry; rotation appears in changed-field audit metadata. Do not expose endpoint configuration to ordinary users.

Route revision invalidation is process-local. Other web/worker/MCP processes observe changed routes within the 15-second TTL; per-request live credential checks immediately prevent stale destination/provider/enabled snapshots from issuing HTTP. Destination drift is retryable for assistant runs. The joined SQL runtime loader preserves one coherent route/model/connection snapshot.

Discovery skips malformed/overlong IDs, shares bounds, resolves an Ollama credential once per bounded discovery operation, and limits fan-out with a common deadline. Model tests update model status only. The persisted `LlmConnection.settings` field remains reserved for schema compatibility and has no active runtime semantics.

## Outbound MCP connection internals

- The endpoint origin is the credential boundary: `updateExternalConnection`
  rejects an origin change on a bearer connection without a new token
  (`BAD_REQUEST`, `field: "token"`), and the dialog mirrors it with
  `needsTokenReentry` in `connectionDraft.ts`. Same-origin path and query edits
  keep the token.
- `@weaver/external-mcp` `schemas.ts` bounds validation cost, because
  validation runs synchronously on the web/worker event loop where no timeout
  can interrupt it. Expanded `$ref` size is capped at
  `MAX_EXPANDED_SCHEMA_NODES`; refs must be local JSON pointers into the same
  schema (`#`, `#/$defs/*`, `#/properties/...`; own-property traversal only);
  same-instance cycles and definitions with more than one
  ref back into their cycle are unsupported (binary and and/or trees are
  deliberately rejected); `uniqueItems` needs scalar `items.type`. Such tools
  stay listed as `UNSUPPORTED_SCHEMA`. Validators are cached by schema sha256.
  Tests assert `supportStatus` only — never validate against a hostile schema.
  `pattern`/`patternProperties` run on RE2 (`re2js` via Ajv `code.regExp`),
  so remote regexes match in linear time; RE2-incompatible patterns
  (backreferences, lookarounds) fail compilation and mark the tool
  unsupported. The engine's wrapper needs a per-pattern `toString()` because
  Ajv deduplicates compiled patterns by it. `allowUnionTypes` is on. Ajv runs
  in strict mode, so a `format` value outside the registered set (`date`,
  `time`, `date-time`, `uuid`, `email`, `uri`) marks the tool unsupported;
  add only fixed `ajv-formats` full-mode formats.

`services/externalMcp.ts` exports connection CRUD, discovery and review with
`assertConnectionManager` (the owner) inside every management entry. Runtime
credentials live in `services/externalMcp/credentials.ts`; connection and approval
AADs are distinct and startup/rotation covers all non-null payloads. Management
writes lock connection → calls → approvals in stable ID order and increment
configuration revisions. Configuration changes invalidate pending and approved
decisions while the call is prepared; already-dispatched calls retain encrypted
arguments until settlement. Discovery runs HTTP outside transactions and saves only
the captured revision. `presentInCatalog` fences removed tools; changed/removed
reviews remain visible but disabled, while endpoint edits clear reviews and presence.
Canonical redirect URLs (including query) are private owner configuration results
and require explicit endpoint save; never include them in diagnostics.
`allowInsecureTls` (default `false`) skips TLS certificate validation for that
connection's requests only, via `rejectUnauthorized` on the pinned outbound
fetch (`packages/config/src/outboundFetch.ts`); every other outbound path
keeps strict validation.

## Remote instances

Administration › Settings › Remote Instances (`/admin/remote-instances`, `remoteInstance`
router's `list/create/update/delete/test` admin procedures) manages the
registry other Weaver instances send documents/tables to and receive them
from. Creating or enabling a remote also creates its peer `OauthClient` row on
this instance directly (`weaver-auth`'s "Remote instance peer clients"); there
is no discovery step and no CIMD. Test fetches `<baseUrl>/api/health` and the
authorization server metadata document and checks the announced
`authorization_endpoint`. Disabling a remote disables its peer OAuth client
and its entry drops out of every user's `remoteInstance.listForUser`; existing
`RemoteInstanceConnection` rows are untouched, so re-enabling restores them.
Sending itself is a user action documented in `weaver-documents` and
`weaver-tables`.

Outbound MCP connections are personal (Account › MCP connections); see `weaver-assistant` › Personal MCP connections.

The admin-only `oidc` router exposes getSettings, testConnection and
updateSettings through `services/oidcSettings.ts`. Settings projections expose
only hasClientSecret; test accepts only an unsaved discovery URL and never saves.
See weaver-oidc for storage, discovery, and runtime identity contracts.

The Administration Settings layout uses `/admin/settings/{ai,remote-instances,oidc}`
with link-based tabs. Legacy AI/remote-instance pages redirect with query values
preserved. Account remote-instance connections remain under Account.
