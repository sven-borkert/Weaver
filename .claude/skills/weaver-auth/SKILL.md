---
name: weaver-auth
description: Use when touching Weaver authentication or authorization — the Better Auth instance (@weaver/auth), sessions and sign-in/out, the /api/auth route, SecurityContext and capabilities, global roles (Admin/User) vs organization/project roles (Owner/Maintainer/Editor/Viewer), membership resolution, or debugging sign-in/session/NOT_FOUND/FORBIDDEN issues.
---

# Weaver Authentication & Authorization

Better Auth email/password or optional external OIDC → database session cookie → per-request `SecurityContext`; project roles live on Better Auth organization members and are resolved by core services on every call.

For external OIDC login (including Authentik), read `weaver-oidc`: provider configuration, verified-email provisioning/linking, callbacks, and focused integration coverage.

Project/personal-workspace lifecycle uses `weaver-projects`; project-owned machine credentials and publishing use `weaver-project-api`; peer connection/refresh/transfer uses `weaver-remote-instances`.

## Key files

| Path                                          | Role                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/auth/src/index.ts`                  | `createWeaverAuth()` — Prisma adapter, uuid ids, admin/organization/jwt/api-key/mcp/cimd plugins, `disableSignUp`, `DISABLED_*_PATHS`, 7-day sessions                                                                                                                                                                     |
| `packages/auth/src/users.ts`                  | `createCredentialUser()` — transactional seed/bootstrap user and credential creation through Better Auth hooks                                                                                                                                                                                                            |
| `packages/auth/src/apiKeys.ts`                | `createApiKeyIssuer()` — mints/lists/revokes keys through Better Auth's api-key plugin internals; never the plugin's own HTTP routes                                                                                                                                                                                      |
| `packages/auth/src/adminUsers.ts`             | `createUserAdministrator()` — the admin-plugin port for user administration: `create` via `auth.api.createUser` (trusted headerless call); `setRole`/`ban`/`unban`/`setPassword`/`revokeSessions` via `internalAdapter`/`password` primitives (`adminMiddleware` has no headerless escape)                                |
| `packages/auth/src/passwordChange.ts`         | `createPasswordChanger()` — self-service `/change-password` port, run with the caller's real request headers                                                                                                                                                                                                              |
| `packages/auth/src/passwordChangeGate.ts`     | `PASSWORD_CHANGE_ALLOWED_PATHS`, `isAllowedWhilePasswordChangeRequired()`, `isPasswordChangeRequired()` — the shared before hook's allowlist while `mustChangePassword` is set, and the OAuth provider's `postLogin` predicate                                                                                            |
| `packages/auth/src/bearer.ts`                 | `createBearerVerifiers()`, `parseBearerToken`, `resolveBearerCredential`, `verifyResourceRequest` — API-key verification or OAuth JWS verification via `better-auth/oauth2`, DPoP binding, and the database-backed replay store                                                                                           |
| `packages/auth/src/bootstrap.ts`              | `bootstrapAdmin()` — creates the first global Admin; explicit recovery for a sole matching orphan                                                                                                                                                                                                                         |
| `apps/web/src/server/auth/index.ts`           | Web instance with `nextCookies()`, `onSignIn` → `lastLoginAt`; `getSessionUser(headers)` (banned users resolve to `null`); passes `mcp: { resource, loginPage, consentPage }`                                                                                                                                             |
| `apps/web/src/app/api/auth/[...all]/route.ts` | `toNextJsHandler(auth)` behind `withAuthRequestBasePath`, which restores the public base path stripped by Next                                                                                                                                                                                                            |
| `apps/web/src/lib/authClient.ts`              | `better-auth/react` client with `oauthProviderClient()`, mounted under `withBasePath("/api/auth")`                                                                                                                                                                                                                        |
| `apps/web/src/app/(auth)/login/`              | Login page + form (`authClient.signIn.email`) + `safeLoginCallbackUrl`; resumes an in-flight authorization via the signed `oauth_query`                                                                                                                                                                                   |
| `apps/web/src/app/(auth)/consent/`            | OAuth consent page/form — names the client, resource, and scopes, and states the write consequence before approval                                                                                                                                                                                                        |
| `apps/web/src/app/.well-known/`               | Root RFC 8414/9728 discovery routes (`oauth-authorization-server`, `oauth-protected-resource`)                                                                                                                                                                                                                            |
| `apps/web/src/app/(workspace)/layout.tsx`     | Server gate: `getSessionUser(await headers())` → `redirect("/login")`                                                                                                                                                                                                                                                     |
| `apps/web/src/server/api/trpc.ts`             | Context `{ db, session, security, headers, apiKeyIssuer }`; `publicProcedure`, `authedProcedure`, `adminProcedure`                                                                                                                                                                                                        |
| `packages/core/src/security/context.ts`       | `SecurityContext` (`UserSecurityContext \| WikiAgentSecurityContext`), `isHumanPrincipal`, `requireUserId`, `createWikiAgentSecurityContext`, `Capability`, `createSessionSecurityContext`, `createApiKeySecurityContext`, `createOAuthSecurityContext`, `hasCapability`, `mayAccessProject`, `requiredCapabilityForRole` |
| `packages/core/src/security/bearer.ts`        | `resolveBearerSecurityContext()` for legacy callers, consent-aware `resolveMcpPrincipal()` for the MCP gate, and API-key-only `resolveApiKeySecurityContext()` for non-MCP HTTP entry points (the external ingestion feed); all share constrained `SecurityContext` construction                                          |
| `packages/core/src/services/apiKeys.ts`       | `apiKey` router's service layer: validates capabilities/project restrictions, calls `ApiKeyIssuer`, maps rows to `ApiKeySummary`                                                                                                                                                                                          |
| `packages/core/src/services/oauthConsents.ts` | Lists and revokes OAuth consents; revocation is enforced by `resolveMcpPrincipal` on the next MCP request                                                                                                                                                                                                                 |
| `packages/core/src/services/projectAccess.ts` | `resolveProjectAccess`, `assertProjectRole` — restriction ∩ membership ∩ capability ∩ role                                                                                                                                                                                                                                |
| `packages/core/src/roles.ts`                  | `ProjectRoleName`, rank, and `to/fromOrganizationRole` (Owner→owner …)                                                                                                                                                                                                                                                    |

## Conventions

- Services take `actor: ProjectActor` (= `UserSecurityContext`): `actor.userId`, `actor.globalRole`, `actor.capabilities`, `actor.allowedProjectIds`. Routers pass `ctx.security`; `account.me` reads `ctx.session.user`.
- `SecurityContext` is a discriminated union on `kind`. A `wikiAgent` context has no `userId` or `globalRole`, so it does not type-check against a user-only service. Only agent-reachable code takes the union: `resolveProjectAccess`/`assertProjectRole` (overloaded: a user gets `ProjectAccess`; the union adds `membership: null` and synthetic `Editor`, live agent required, `NOT_FOUND` elsewhere), `listProjectsForUser`, `resolveScopeSnapshot`, `effectiveScope`, the content reads behind `defineSharedReadTool`, `wikiReads` and `applyWikiOperation`. When a user-only service becomes agent-reachable, widen its parameter and narrow every user read with `isHumanPrincipal` or `requireUserId`, never a cast or a sentinel id.
- Task deny-lists (`assertTrainer`, `trainerProjectIds`, `assertConnectionManager`, `listAvailableExternalTools`) refuse `!isHumanPrincipal(actor)` first, so a new machine method stays refused. Actor snapshots (`assistant/actor.ts`) are user-only; a stored `wikiAgent` method fails to parse.
- Non-members get `NOT_FOUND`, never `FORBIDDEN` — including global Admins (spec §6.1). Admin-only surfaces use `adminProcedure`/`llm:admin`; project content always needs membership.
- Browser queries publish `UNAUTHORIZED`, `FORBIDDEN`, and `NOT_FOUND` immediately;
  `trpc/query-client.ts` skips retries for these codes using `isQueryAccessError`.
  Retry backoff must not keep revoked cached access looking active. Transient
  browser failures retain three retries; server queries retain none.
- Sessions carry `assistant:use`, `content:read`, `content:propose`, and `content:write`; global Admin sessions additionally carry `llm:admin` and `system:admin`. `mcp:use` is granted only to API keys/OAuth tokens, never sessions. Reads need `content:read`, mutations `content:write`.
- Personal API keys default to `mcp:use` + `content:read`; `content:propose`/`content:write` are explicit opt-ins. `ingest:external` is a third explicit opt-in that only grants the external feed channel (`POST /api/ingestion/external`); it never implies `content:write`, is never a session or OAuth capability, and still requires Editor membership on the target project. A global Admin may also grant `system:admin`, which implies `llm:admin` only while the owner's current role remains Admin; demotion leaves the key active but removes both effective admin capabilities. OAuth scopes never include `system:admin`. An omitted custom rate limit keeps Better Auth's 10,000-request/minute default, and fail-closed disabled rows must remain visible as disabled. Keys are minted, listed, updated, and revoked only by a signed-in session actor through the `apiKey` tRPC router (`ApiKeyProject` enforces project restrictions). `apiKey.update` (`updateApiKey`) rewrites name, `permissions`, rate limit and `ApiKeyProject` rows in one transaction and shares `validateKeyPolicy` with create; expiry is fixed at creation, a User saving a key with a dormant `system:admin` grant drops it, and after the plugin verifies the secret, `resolveVerifiedCredentialContext` reads the key's current `permissions`, `enabled`, owner and `ApiKeyProject` rows in ONE SQL statement — a key revoked or edited mid-request is rejected or gets its new coherent policy, never the verifier's old permissions with new (or vanished = unrestricted) restrictions; do not split that read — the plugin's own `/api-key/*` HTTP routes are disabled (`DISABLED_API_KEY_PATHS`).
- `external:use`: API keys (opt-in) and OAuth scope; lets MCP credentials call the tools the credential's user enabled on their own connections; never a task capability.
- `external:manage`: API-key opt-in and OAuth scope, also a session capability; manages the user's own connections through the MCP connection tools; never a task capability.
- `UserSecurityContext.authenticationMethod` is `"session" | "apiKey" | "oauth" | "task"`; the agent's is `"wikiAgent"`; bearer-derived contexts also carry `credentialId` (key id or token id). Role-gated reads that must stay reachable by read-only credentials pass an explicit capability override to `assertProjectRole(tx, projectId, actor, min, { capability: "content:read" })` instead of inheriting the role's default (write) capability.
- `DISABLED_API_KEY_PATHS`, `DISABLED_OAUTH_MANAGEMENT_PATHS`, and `DISABLED_JWT_PATHS` close the api-key plugin's HTTP surface, OAuth dynamic client registration/self-management, and session-minted JWTs (`/token`) respectively — only Weaver's own tRPC/OAuth-token-endpoint paths mint credentials.
- The OAuth 2.1 foundation is `@better-auth/mcp` (authorization code + PKCE, consent, audience-bound EdDSA access tokens, JWKS) plus `@better-auth/cimd` for Client ID Metadata Document discovery — no dynamic client registration. CIMD `redirect_uris`, `post_logout_redirect_uris`, and `client_uri` are origin-bound; the plugin preserves loopback and reverse-domain private-use native-client exceptions. The login form resumes an in-flight authorization via the signed `oauth_query` forwarded by `oauthProviderClient()` (`apps/web/src/lib/authClient.ts`); the consent page names the client, resource, and requested scopes and states the write consequence before approval.
- OAuth grants have one live `OauthConsent` per `(userId, clientId)` and an immutable `referenceId` generation propagated through Better Auth refresh rows and the private `weaver_authorization_id` access-token claim. Authorization-code and access-token inserts lock the matching consent row and require scope/resource containment; refresh inserts lock the exact generation; revocation locks that row first, deletes it, and revokes token rows. The MCP boundary must require the exact live generation and recheck the token scopes/resource. Never fall back to user/client consent existence. Grant list/revoke lives in the session-only `oauthConsent` tRPC/service path; API-key/OAuth actors cannot manage grants.
- OAuth access tokens are self-contained JWTs; `resolveMcpPrincipal` additionally requires an `OauthConsent` row for the token's client, user, and exact authorization generation (revocation takes effect on the next request), plus the `mcp:use` capability (403 `insufficient_scope`). A token carrying `cnf.jkt` must arrive with the `DPoP` scheme and a valid proof (`enforceDpopBinding`, database-backed replay store); a token without `cnf` is plain bearer. Before reserving a proof, prune only expired `dpop-proof:` Verification rows; preserve live DPoP and every unrelated Better Auth verification row. The partial `Verification_dpop_replay_expiry_idx` supports this without weakening the unique first-writer reservation. JWKS reads go through Better Auth's cached function source (`jwksCacheKey`).
- The Phase 4F deployment migration is an intentional full authority cutover: while holding locks on consent, access-token, and refresh-token tables, it rotates every existing consent generation and revokes every existing OAuth token. If it is pending on an existing database, only the guarded `@weaver/db migrate:deploy` path is valid: stop every runtime/client, take the consent-table `EXCLUSIVE` barrier first, and let the wrapper hand it to Prisma. Never edit the applied migration, bypass the quiescence check, weaken this to a timestamp heuristic, or use a later migration as a fictional repair of the historical execution.
- `WEAVER_MCP_RESOURCE_URL` is the audience access tokens are bound to (defaults to `<AUTH_URL origin><base path>/api/mcp`); explicit resource/issuer URLs lose a non-root trailing slash so consent, JWT claims, metadata, and the handler compare one canonical URL. Better Auth rejects `http://` off loopback.
- Membership writes go through `packages/core/src/services/projectMembers.ts` / `projects.ts` (Prisma `Member` rows); Better Auth's generic organization reads and mutations are disabled; retained organization membership must not expose soft-deleted projects.
- The admin plugin's entire HTTP surface (`/admin/*`, including `impersonate-user`) is deliberately disabled via `DISABLED_ADMIN_PATHS` and stays disabled — no `/admin/*` route is HTTP-routable. Weaver reaches the plugin's **server API** in-process instead, through `packages/auth/src/adminUsers.ts` (`createUserAdministrator`), and its six operations are **not** uniformly reachable that way — the split was established empirically, not assumed. `create` calls `auth.api.createUser`, whose handler only rejects a missing session when `ctx.request`/`ctx.headers` are set, so a headerless `{ body }` call is treated as trusted — the same mechanism `createApiKeyIssuer` already uses for `auth.api.createApiKey`. The other five (`setRole`, `ban`, `unban`, `setPassword`, `revokeSessions`) run behind `adminMiddleware`, which throws `UNAUTHORIZED` unconditionally with no headerless escape (`setRole` additionally sets `requireHeaders: true` and rejects even earlier), so they bypass the plugin's HTTP-shaped API entirely and write through its own `internalAdapter`/`password` primitives instead — mirroring how `createCredentialUser` (`packages/auth/src/users.ts`) already bypasses the plugin for user creation. Before adding a call to a new admin-plugin endpoint, check empirically which bucket it falls into; do not assume a headerless call is trusted.
- `User.mustChangePassword` is declared to Better Auth via `user.additionalFields` in `createWeaverAuth` (`type: "boolean", defaultValue: false, input: false`), which is what lets it reach `SessionUser` the same way `role`/`banned` do — a column added to Prisma alone would not appear on `result.user`. It is set on admin-created and admin-reset accounts (`packages/core/src/services/users.ts`) and cleared only by a successful self-service change. `requireActiveUser` (`apps/web/src/server/api/trpc.ts`) rejects every procedure while it is set except an exact two-procedure allowlist — `account.me` and `account.changePassword` — miss either one and a flagged user is either exposed to app data or locked out with no recovery path (there is no email transport). Two non-tRPC session-authenticated routes carry the identical check by hand: the assistant SSE stream (`apps/web/src/app/api/assistant/runs/[runId]/events/route.ts`) and the ingestion upload route (`apps/web/src/app/api/ingestion/uploads/route.ts`). The workspace layout's redirect to `/account/password` is a UX nudge only; `requireActiveUser` is the authoritative gate. The OAuth consent page (`apps/web/src/app/(auth)/consent/page.tsx`) carries the check too, and matters more than the others: a flagged user completing consent gets a working token whose `content:write` capability MCP's write tools gate on with nothing else, and MCP requests never pass through `requireActiveUser`. Rather than a plain 403, it must abort the in-flight authorization cleanly — a bare redirect would strand the waiting client, which navigated expecting a `redirect_uri` callback. `denyFlaggedConsent` (`apps/web/src/app/(auth)/consent/mustChangePasswordGate.ts`) calls `auth.api.oauth2Consent({ body: { accept: false, oauth_query } })` in-process before the page ever renders `ConsentForm` — the same call the page's own "Deny" button makes client-side, verified via `toAuthEndpoints` to run the oauth-provider plugin's hooks identically whether invoked through `auth.api.*` or the HTTP router — producing the same spec-compliant `access_denied` redirect to the client. The page is the only OAuth exit for a flagged user because two things in `createWeaverAuth` route everything there. The shared before hook rejects every cookie-authenticated Better Auth request — HTTP or in-process `auth.api.*`, since `toAuthEndpoints` runs the same hook pipeline for both — while the flag is set, except `PASSWORD_CHANGE_ALLOWED_PATHS` (`packages/auth/src/passwordChangeGate.ts`: `/sign-in/email`, `/get-session`, `/sign-out`, `/change-password`, `/oauth2/authorize`) plus an `/oauth2/consent` _denial_; so a direct acceptance replay of a signed `oauth_query` is FORBIDDEN and any future route is covered. Never move `/get-session`, `/change-password`, or the consent denial into the blocked set: `getSessionUser`, `createPasswordChanger`, and `denyFlaggedConsent` all reach Better Auth through that hook, and blocking them locks a flagged user out with no recovery path. The OAuth provider's `postLogin.shouldRedirect` (page = the consent page; `consentReferenceId` returns `undefined` because a database trigger assigns Weaver's consent generations) runs ahead of the provider's existing-consent shortcut, so a prior `OauthConsent` row no longer lets `/oauth2/authorize` mint a code without the page rendering, and the provider re-runs it for a consent posted with a signed query lacking its cleared-for-session marker. The flag gates interactive use only and is never read on the bearer path; containment for a reset is explicit revocation instead (`resetUserPassword`, next bullet). A missing, malformed, or unsigned `oauth_query` (or any other failure) is caught and falls back to a plain `/account/password` redirect; the check runs immediately after `getSessionUser`, before the `clientId`/`scopes` validation.
- `resetUserPassword` (`packages/core/src/services/users.ts`) is containment, not just a new password: in one transaction it sets `mustChangePassword`, deletes the user's personal API keys, and calls `revokeAllOAuthGrantsForUser` (`packages/core/src/services/oauthConsents.ts`: lock the user's consent rows in id order, delete them, mark refresh and access tokens revoked — the same row-first order the single revoke and the provider's inserts take), then sets the password and revokes sessions. Nothing returns when the forced change completes. Deactivation remains the reversible kill switch (`banned` is checked live on every path); a reset is the irreversible one, and the Access card's dialog says so.
- Password and session mutations are serialized per user: `resetUserPassword` and `changeOwnPassword` (the only caller of `PasswordChanger`, used by `account.changePassword`) both run under `withUserCredentialLock`, a `pg_advisory_xact_lock` on `weaver:user-credentials:<userId>` held by an outer transaction. Better Auth's change-password handler reads the hash, hashes, then writes without a transaction, so an unlocked change could finish after an admin reset and undo it. The HTTP route `/api/auth/change-password` is disabled (`DISABLED_ACCOUNT_PATHS`) so nothing bypasses the lock; the in-process `auth.api.changePassword` call is unaffected and `/change-password` stays in `PASSWORD_CHANGE_ALLOWED_PATHS` for its before-hook. The forced-change flag is cleared inside the lock, only after the provider accepted the change.
- One password policy: `PASSWORD_MIN_LENGTH` (12) and `PASSWORD_MAX_LENGTH` (128, the provider ceiling) live in `@weaver/auth/constants`, configure `emailAndPassword.minPasswordLength/maxPasswordLength`, and are re-exported through `userSchemas.ts` for services, routers and forms. Never hard-code a password bound.
- `packages/core/src/services/users.ts`'s `setUserMembership` is a deliberate, bounded narrowing of reconciliation spec §6.1 ("global Admin is not a content superuser"): unlike every other membership write, it skips `assertProjectRole`, so an Admin may add, re-role, or remove membership on **any** project — including restoring an Owner to one they do not belong to — without the "cannot grant a role equal to or above your own" rank rule applying. The single absolute guard that makes this safe: an Admin can never grant, change, or remove **their own** project membership; that check runs before any project/user lookup, not just before the write. This preserves the direct content API boundary: an Admin cannot read or write content without membership. Account/password recovery can nevertheless confer indirect content access, so global Admins remain trusted lifecycle administrators; every change is recorded in the diagnostic log.
- Better Auth's public `baseURL` is `<AUTH_URL origin><base path>/api/auth`, so the issuer and every advertised endpoint include the base path. Next strips `NEXT_PUBLIC_BASE_PATH` before routing; the auth route adapter restores it before calling Better Auth, while the browser client adds it to requests. `AUTH_URL` is the site origin; leave it unset in dev.
- Tests: `_setup.ts` mocks `~/server/auth`; use `testAuth()` / `TEST_PASSWORD` / `securityContextFor(user)` / `makeUser()` from `_harness.ts` for real Better Auth behaviour (`auth.spec.ts` is the reference).
- Better Auth rate-limits `/sign-in*` (3 requests/10s per IP) by default only when `NODE_ENV === "production"`; `rateLimitEnabled` on `createWeaverAuth()` / `WEAVER_AUTH_RATE_LIMIT_ENABLED` overrides that default (unset keeps Better Auth's own behavior). `LoginForm.tsx` shows a distinct "Too many sign-in attempts" toast on a 429, otherwise "Invalid credentials".
- `/account/connected-apps` lists and revokes consents through the
  `oauthConsent` router; only session actors may manage them.
- Credential creation hashes first, then runs user/account writes through
  `runWithTransaction` with Prisma adapter transactions enabled. Bootstrap is
  also a production caller. Its explicit `recoverInterrupted` option accepts
  only a sole matching verified, unbanned Admin without accounts, sessions,
  or memberships; ordinary existing users never receive a new password.
- `bootstrapAdmin` remains a single-operator deployment command;
  serialize it at the database level before supporting concurrent bootstrap
  attempts.
- Active bans (including `banExpires`) are enforced across Better Auth session/OAuth endpoints; the shared hook revokes the user's existing sessions.

## Current credential boundaries

- Browser-safe roles, OAuth scopes, and API-key limits live in `@weaver/auth/constants`; import them instead of copying values.
- Better Auth consent CRUD and end-session routes are disabled; Weaver's transactional consent service owns grant management. Server-only disabled entries are defensive declarations, not independently routable HTTP coverage.
- The shared auth before hook rejects active bans and deletes existing sessions; expired bans no longer deny access. Web `getSessionUser` is request-memoized with React cache.
- Forwarded client addresses are ignored by default. `WEAVER_AUTH_TRUST_PROXY` changes sign-in rate limiting from the shared bucket to the proxy-written, single-value `X-Real-IP`; the private deployment proxy must overwrite it. Forwarded-for chains are not trusted by auth.
- OAuth JWTs require EdDSA and `exp`, `jti`, `sub`, and `scope`. Infrastructure failures propagate as server errors; invalid credentials alone produce authentication failures.
- Better Auth does not persist self-contained JWT access tokens in `OauthAccessToken`. `oauthRevocation.ts` handles its authenticated, signature-verified RFC7009 unsupported-JWT response by recording the issuing client's token `jti` in the expiring Verification denylist. MCP checks that denylist and the exact consent generation; offline grants also require a live refresh family and no explicitly revoked non-rotated family in that generation. Explicit refresh revocation invalidates the grant generation; clear it through Weaver consent management before reauthorizing. Provider reuse detection deletes live refresh rows; an AFTER DELETE database trigger removes that consent generation, so reauthorization creates a new generation and never revives old JWTs. Expired-row cleanup does not revoke grants. Do not replace this with an access-token-row lookup that rejects every JWT.

- Login and consent forms own redirect navigation. The auth client disables Better Auth's default redirect fetch plugin to avoid cancelling OAuth callbacks with duplicate navigation. Anonymous-to-signed-in state replaces the client query cache without reloading the login page; authenticated principal changes still mask stale server children and reload.

The dashboard router is session-only with content:read. Pin management requires
both Maintainer project rank and content:write; a read-only Maintainer may inspect
shared work but receives no pin capacity or unavailable placeholders. Global Admin
never bypasses membership. Home activity defaults to mine even with a project
filter; only an explicit authorized projects audience requests shared results.

## Review integrity boundaries

Production requires an explicit public HTTPS AUTH_URL (loopback HTTP is reserved
for local runs); trusted origins and secure cookies derive explicitly from it.
Without a trusted proxy, IP tracking remains enabled and the limiter falls back
to its shared per-path bucket; never disable that fallback.
Admin membership rescue shares lockProjectMembershipWrites and the last-Owner
guard with ordinary membership changes. Role/ban writes and session deletion
use the same Prisma transaction that holds the Admin roster lock.
OAuth consent UI verifies the complete signed query before displaying client,
redirect, scope or resource. SSE checks session revocation every 15 seconds and
caps each user's simultaneous streams at six per web process.

## September 22 review boundaries

Deactivation and self-service password change revoke every API key and OAuth
grant, using the reset containment helper; reactivation cannot resurrect them.
`/update-user` is disabled along with `/change-password`: display names remain
admin-managed and cannot bypass Weaver's validated name rules.
`ApiKeyProject.project` uses `onDelete: Restrict` so hard deletion cannot silently
remove a key's final restriction and widen access; revoke/edit affected keys before
purging projects. The administration project picker is capped at 1,000 rows with
stable name/id ordering.

## Remote instance peer clients

Registering a remote Weaver instance (`weaver-admin`) also creates that
peer's `OauthClient` row on this instance directly — `weaver-instance:<peer
base URL>` (`remoteClientId`, `packages/core/src/remotes/urls.ts`), a public
PKCE client, redirect URI `<peer base URL>/api/remotes/callback`, disabled
when the remote is disabled. There is no CIMD (it needs a publicly routable
`client_id` host, which Tailscale's 100.64/10 range is not) and no DPoP
(`resolveMcpPrincipal` uses one URL as both the DPoP `htu` and the consent
resource, and only one audience exists for these tokens) for these rows;
tokens are plain bearer, encrypted at rest with the same key ring as
`ExternalMcpConnection`. A remote's transfer requests reuse the existing MCP
resource audience (`<base URL>/api/mcp`) rather than a new `OauthResource`,
so the consent screen names "Weaver MCP" — see `weaver-documents` and
`weaver-tables` for what a send actually transfers.

The global Admin membership/password recovery surface is trusted administration:
no direct content bypass exists, but account control can confer indirect content
access. Owners/Maintainers add registered members immediately and can discover
account existence through that authorized workflow; invitation consent is not
implemented. Project metadata updates deliberately require Editor. A shared
origin includes every co-hosted application in the trust boundary, regardless
of cookie paths. See docs/setup.md for the deployment contract.

## Project machine credential foundation

Project-owned keys live in ProjectApiKey, independently of Better Auth personal
keys and user lifecycle revocation. security/projectMachine.ts resolves a
ProjectMachineContext with project/key identity and no userId or global role.
The wvr_project_ prefix must never authenticate through personal-key/OAuth/MCP
gates. Creator SetNull is administrative attribution, not access ownership.
projectApi/credentials.ts stores only SHA-256 digests; projectApi/rateLimit.ts
uses a live-key/project-filtered atomic UTC minute counter and finishes before
repository locks. See the approved project-machine-api spec and implementation
reference for the content-policy boundary.

Project key management (`services/projectApiKeys.ts`, router `projectApiKey`)
refuses every non-session principal (apiKey, oauth, task) with FORBIDDEN and
requires Maintainer plus `content:write`; non-members, Admins included, get
NOT_FOUND. A creator's demotion, departure, password reset, deactivation or
deletion never touches a project key: user-lifecycle revocation only deletes
personal `apiKey` rows. Revocation is irreversible and bumps policyVersion.

The optional web `oidcResolver` supplies request-scoped OIDC snapshots without
recreating Better Auth. Password/session/MCP paths never depend on discovery.
See weaver-oidc for guarded transport and trusted state-generation binding.

## Exams

Training roles are orthogonal to content ranks. `services/projectTraining.ts` gates trainer and session-trainee exam access; Off grants no exam powers. See `weaver-exams`.

## Review hardening invariants

OAuth bearer resolution requires a live enabled client. JWT introspection enforces JTI revocation, exact live consent generation and refresh-family state. Consent writes use oauthConsentAdapter with the same per-user credential lock as lifecycle revocation and revalidate the persisted session. Browser RPC logging excludes credential routers and redacts all payloads.
