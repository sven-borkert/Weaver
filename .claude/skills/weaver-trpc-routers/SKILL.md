---
name: weaver-trpc-routers
description: Use when adding or changing tRPC procedures, routers, or zod input schemas in apps/web/src/server/api — new project/member procedures, list or mutation endpoints, per-project access checks through packages/core services, admin procedures, or NOT_FOUND/FORBIDDEN/CONFLICT/PRECONDITION_FAILED error mapping and field-pinned form errors.
---

# Weaver tRPC Router Conventions

Routers are thin web adapters: input schema → session → `@weaver/core` service
call → transport error mapping. Business logic and permission checks live in
`packages/core/src/services/`. Every project-scoped procedure resolves
membership through `resolveProjectAccess`/`assertProjectRole`; routers never
check membership themselves.

## Key files

| Path                                                          | Role                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/server/api/trpc.ts`                             | Procedure ladder (`publicProcedure`, `authedProcedure`, `adminProcedure`); errorFormatter exposes Zod, field, conflict-descriptor, and head-SHA metadata                                                                                                                                                                 |
| `apps/web/src/server/api/root.ts`                             | Registry for account, project/member, document/table/folder, search, graph, knowledge, LLM, and assistant routers                                                                                                                                                                                                        |
| `apps/web/src/server/api/routers/project.ts`                  | Canonical thin entity router (list/get/create/update/delete)                                                                                                                                                                                                                                                             |
| `apps/web/src/server/api/routers/projectMember.ts`            | Member management (list/add/updateRole/remove)                                                                                                                                                                                                                                                                           |
| `apps/web/src/server/api/routers/account.ts`                  | `account.me`, `changePassword`, `landingProject`, `recordLastOpenedProject` — session user, forced password change, last-opened project                                                                                                                                                                                  |
| `apps/web/src/server/api/routers/apiKey.ts`                   | `apiKey.create`/`list`/`revoke` — session-only (never bearer-authenticated); calls `ctx.apiKeyIssuer` via `packages/core/src/services/apiKeys.ts`                                                                                                                                                                        |
| `apps/web/src/server/api/routers/llm.ts`                      | `llm` Admin router; `adminProcedure` adapter whose core services re-check `llm:admin`                                                                                                                                                                                                                                    |
| `apps/web/src/server/api/routers/assistant.ts`                | `assistant` router — conversations/messages/proposals/`listCitations`; calls `assistantConversations.ts`/`assistantRuns.ts`/`assistantProposals.ts`/`assistantCitations.ts`                                                                                                                                              |
| `apps/web/src/app/api/assistant/runs/[runId]/events/route.ts` | The one authenticated non-tRPC read endpoint: SSE replay-from-`after`-cursor (falling back to the `Last-Event-ID` request header when `?after=` is absent) plus ~1 s polling over `listRunEvents`; a mid-stream failure sends a `stream.error` frame, not `error` — `EventSource` reserves that name for transport drops |
| `apps/web/src/server/api/schemas/llm.ts`                      | LLM connection/model/test/route input schemas                                                                                                                                                                                                                                                                            |
| `apps/web/src/server/api/schemas/project.ts`                  | Project input schemas                                                                                                                                                                                                                                                                                                    |
| `apps/web/src/server/api/schemas/projectMember.ts`            | Member input schemas                                                                                                                                                                                                                                                                                                     |
| `packages/core/src/services/projectAccess.ts`                 | `resolveProjectAccess`, `assertProjectRole`, `PROJECT_ROLE_RANK`, `notDeleted`, `ProjectActor`                                                                                                                                                                                                                           |
| `packages/core/src/services/projects.ts`                      | Project business logic, permission checks, and transactions                                                                                                                                                                                                                                                              |
| `packages/core/src/services/projectMembers.ts`                | Member business logic, permission checks, and transactions                                                                                                                                                                                                                                                               |
| `packages/core/src/errors.ts`                                 | Transport-neutral `CoreError` and metadata                                                                                                                                                                                                                                                                               |
| `apps/web/src/server/api/coreError.ts`                        | `CoreError` → `TRPCError` adapter                                                                                                                                                                                                                                                                                        |
| `apps/web/src/lib/trpcErrors.ts`                              | `applyTrpcErrorToForm()` — server `err.data.field` → RHF `setError`                                                                                                                                                                                                                                                      |

## Conventions

- Project/member routers use `authedProcedure` for reads AND writes — per-project membership (resolved in the service), not the global role, is the authority. `adminProcedure` is used by instance-level admin procedures such as `llm`; the service still re-checks `llm:admin`. There is no global-Admin bypass for project content — membership is required, and the same role-grant rules apply to everyone.
- Error mapping is deliberate: project missing OR caller not a member → **NOT_FOUND** (hides existence — no FORBIDDEN leak); insufficient role → **FORBIDDEN**; duplicate membership → **CONFLICT**; last-Owner protection → **PRECONDITION_FAILED**; self-membership edits → **BAD_REQUEST**. Assert via the service helpers (`packages/core/src/services/projectAccess.ts`), don't re-derive codes inline.
- Reads: `resolveProjectAccess(tx, projectId, actor)` fetches via `findFirst({ where: { id, ...notDeleted } })` and throws NOT_FOUND on miss or non-membership; `assertProjectRole` adds the minimum-role check (e.g. `Viewer` for reads, `Editor` for project updates, `Owner` for delete).
- Mutations: service does access assert → write (in `db.$transaction` when multi-step, e.g. `createProject` writes project + Owner membership). Never `Promise.all` on `tx` (single pg connection).
- Field-pinned service errors use
  `new CoreError(code, message, { field: "<rhfField>" })`; the adapter in
  `apps/web/src/server/api/coreError.ts` preserves the details as the tRPC
  cause, and the formatter in `apps/web/src/server/api/trpc.ts` lifts the field
  to `err.data.field` for
  `apps/web/src/lib/trpcErrors.ts`.
- Structured conflict errors may put `conflicts` and a string `headCommitSha`
  on the cause; the formatter exposes both as nullable error-data fields.
- Zod inputs live in `apps/web/src/server/api/schemas/<area>.ts` as `<verb><Entity>Input` plain ZodObjects; LLM schemas are shared with MCP in `packages/core/src/services/llmSchemas.ts` and re-exported by the web module. The same shape is mirrored client-side by the forms (see weaver-forms-dialogs). Change validation surfaces together.
- Operations whose work can exceed a fixed server batch expose a validated
  stable cursor and return continuation state. `knowledge.retryFailed` uses a
  `{generationId, documentId}` cursor and never locks/updates more than 200
  candidates per call.
- Services take `ctx.security` (type `ProjectActor` = `SecurityContext`) as the actor; routers pass it through and never resolve membership themselves. `ctx.security.authenticationMethod` (`session`/`apiKey`/`oauth`) lets a service refuse a bearer-authenticated caller for a session-only procedure (e.g. `apiKey.create`) rather than trusting the transport.
- `ctx.apiKeyIssuer` (`createApiKeyIssuer`) is the only way to mint/revoke a key row; only `apiKey.ts` calls it.
- `ctx.encryptionKeys` and `ctx.llmFetch` are the LLM router's injected
  key-ring and provider-HTTP dependencies. Pass them into core as
  `{ ring, fetchImpl }`; never read process env or call global fetch inside an
  LLM service.
- A role-gated read that a read-only credential must still reach passes an explicit override to `assertProjectRole(tx, projectId, actor, min, { capability: "content:read" })` instead of the role's default (write) capability — see `knowledge.status` for the pattern.
- Underscore-prefixed files in `routers/` are helpers, never registered; entity routers register in `root.ts`.
- Every new/changed procedure needs a mirrored integration spec — CLAUDE.md Standing Rule #4 (see weaver-testing).

## How to: add a new project-scoped entity router

1. Create `apps/web/src/server/api/schemas/<entity>.ts`: `createXInput`, `updateXInput`, id inputs (`projectId: z.uuid()`).
2. Create the transport-independent service in `packages/core/src/services/<entity>.ts`: every function takes `(db, ..., actor: ProjectActor)` and starts with `resolveProjectAccess`/`assertProjectRole`; import Prisma types from the public `@weaver/db/client` subpath.
3. Create the thin router in `apps/web/src/server/api/routers/<entity>.ts` from `project.ts`/`projectMember.ts`: `authedProcedure`, `.input(...)`, pass `ctx.security` as the actor, and map `CoreError` at the adapter boundary.
4. Register in `apps/web/src/server/api/root.ts`.
5. If soft-deletable, spread `notDeleted` on reads (weaver-database).
6. Add and run `apps/web/tests/integration/<entity>.spec.ts` (Standing Rule #4, Tier 1).

## Common mistakes

| Mistake                                        | Reality/Fix                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| FORBIDDEN for a non-member / missing project   | NOT_FOUND hides existence; `apps/web/tests/integration/projects.spec.ts` asserts the codes             |
| Checking membership in the router              | Services resolve it via `assertProjectRole`; routers stay thin                                         |
| `findUnique({ id })` on `Project`              | Returns soft-deleted rows; `findFirst` + `...notDeleted`                                               |
| `Promise.all` on `tx`                          | One pg connection — sequential loops are intentional                                                   |
| Assuming global Admin bypasses membership      | No global-Admin bypass — membership is required; grant rules apply to everyone                         |
| Letting a member grant a role ≥ their own      | Grant rules live in `projectMembers.ts` (`assertCanGrantRole`); no exemptions, Admins included         |
| Removing/demoting the last Owner               | PRECONDITION_FAILED via `countOwners` — keep the guard on both paths                                   |
| Hand-rolled error codes in a new service       | Use the existing NOT_FOUND/FORBIDDEN/CONFLICT mapping conventions                                      |
| Strict input on a `useInfiniteQuery` procedure | The client adds `cursor` and `direction`; accept and drop `direction` (see `schemas/projectApiKey.ts`) |

## See also

weaver-database (schema/migrations/soft delete), weaver-testing (caller harness, spec recipes), weaver-forms-dialogs (form ↔ schema mirroring), weaver-auth (procedure tiers, roles). CLAUDE.md Standing Rule #4; docs/IMPLEMENTATION.md for the architecture map.

## Complete router inventory and transport policy

`root.ts` registers _meta, account, project, projectMember, document, review, reviewerGroup, folder, table, tableFolder, search, graph, knowledge, llm, assistant, apiKey, oauthConsent, diagnostics, ingestion, projectApiKey, and remoteInstance (Admin registry of peer Weaver instances — `list/create/update/delete/test`; plus authed user procedures `listForUser`, `connect`/`disconnect`, `targets`/`targetFolders`, and `sendDocument`/`sendTable`, which drive the "Send to another Weaver…" dialog). Keep this inventory aligned with the registry when adding areas.

Production 5xx responses use a generic message and omit stack and internal cause metadata. The HTTP adapter always logs internal failures; expected error chatter remains development-only. Request IDs correlate tRPC diagnostic events. Public procedures have diagnostics without artificial latency.

Assistant reads expose `getConversationStatus`, paged `getConversation` (`beforePosition`), lightweight `listProposals`, full `getProposal`, and message-filtered `listCitations`. Preserve current membership checks in service reads and every SSE replay page.

## Review procedures

`review` (`routers/review.ts`, `schemas/review.ts`): `listDue` (cursor-paged
documents due for the caller across accessible projects), `listRecent` (cursor-paged
latest review per document in accessible projects, any reviewer) and `dueCount`
(`{ count, isReviewer }`, drives the sidebar). `reviewerGroup`
(`routers/reviewerGroup.ts`): `list`, `getDefaults` (any member; `canManage` is
true for Owners), and Owner-only `create`, `rename`, `setMembers`, `delete`,
`setDefaults`. `document.markReviewed` is the one document write a Viewer may
perform: the service requires project membership, the `content:write` capability
and effective-reviewer status (not a role), then re-checks both under the
repository lock; a non-reviewer gets FORBIDDEN, an unknown document NOT_FOUND, a
stale `expectedHeadCommitSha` CONFLICT. `document.setReview` needs Maintainer,
rejects an empty change, validates reviewers as current members or existing
groups, and returns the head (unchanged for a no-op). `document.reviewPermissions`
returns `{ canMarkReviewed, canEditReview }`; `document.get` carries the `review`
block but not these flags.

`folder.reviewDefaults` is Viewer-readable and reports effective `reviewers` plus
`configuredReviewers` (preserving explicit empty and unresolved selections),
inheritance source, ownership, `canManage` and project HEAD. `folder.previewReview`
requires Maintainer plus content:read; `setReviewRecursively` and
`clearReviewDefault` require Maintainer plus content:write and a canonical expected
project SHA. Inputs share `folderPathSchema` (root allowed) and `reviewerTarget`
(maximum 50). Core owns Git inventory, limits and revision checks; stale HEAD maps
to CONFLICT and nonmembers/missing projects to NOT_FOUND. Recursive assignment
changes document revisions, so dirty editors retain the ordinary update conflict.

## Dashboard procedures

The `dashboard` router exposes recentContent, activity, reports, projectOverview,
pinCandidates, pin and unpin through `services/dashboard.ts`. All are session-only
and require content:read. Candidates and pin mutations additionally require
Maintainer plus content:write; overview stays readable for read-only Maintainers.
The browser-safe input/DTO source is `@weaver/core/dashboard/schema`. Activity
reads never acknowledge background-work receipts or assistant unseen state.

The fetch transport enforces same-origin JSON POSTs, streams a 16 MiB body cap
before decoding and limits batches to 20 procedures; the client splits batches
at the same count. Integer pagination into Prisma Int columns is capped at
2,147,483,647. Anonymous errors do not create verbose diagnostic rows. Admin
settings UI uses the actor-gated AsAdmin service wrappers; internal runtime
settings caches remain available without a user actor.

## Appearance adapters

`appearance` (`routers/appearance.ts`, `schemas/appearance.ts`) registers `get`
with `{ target }` and `set` with `{ target, expectedRevision, patch }`.
`AppearanceTarget` is the shared document/table UUID or scoped folder path union.
Core `services/contentAppearance.ts` owns access, strict field-pinned patch
validation and locked revision checks. Omitted fields preserve values and null
resets; callers guard item revisions or project HEAD for folders. Multipart
`POST /api/projects/[projectId]/appearance` authorizes the path project before
body reads, caps bytes, validates fields and calls that same mutation with
uploaded image bytes. The icon GET route validates committed bytes and rechecks
Viewer access before conditional responses. Client URLs use `withBasePath`.

## Project API key procedures

`projectApiKey` (`routers/projectApiKey.ts`; schemas re-exported from
`@weaver/core/projectApi/schemas`, except `targets`, whose input also accepts and drops the infinite-query `direction`) registers `list`, `create`, `update`,
`revoke`, `targets`, `configuration` and `unresolvedOperations`. All use
`authedProcedure`; the core service refuses non-session principals and requires
Maintainer plus `content:write`. Service validation pins `name`, `grants`,
`expiresInDays` and `rateLimitPerMinute` field errors. `configuration` receives
the web `env` for the public base URL; core never reads process env for it.
Only `create` returns the secret, and no list or target response contains it.

The admin-only oidc router registers getSettings, testConnection (unsaved URL only),
and updateSettings (expectedRevision plus form values). Core oidcSettings service
rechecks system administration and returns a redacted projection; the server-only
runtime reader is never exposed as a procedure.

## Exams

The `exam` router delegates definition CRUD, trainee attempts and trainer grading to core exam services. Browser-only release is checked by the service; session identity alone does not authorize assistant-marked release.
