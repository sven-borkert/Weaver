---
name: weaver-oidc
description: Use when changing Weaver external OIDC login, Authentik setup, discovery/callback redirects, verified-email account linking or first-login provisioning. Weaver's MCP OAuth provider and peer-instance authorization are separate integrations.
---

# Weaver OIDC login

One optional administrator-configured OIDC provider authenticates browser users through
Better Auth. Local password login remains available. This is separate from
Weaver acting as an OAuth provider for MCP clients.

## Entry points

| File                                          | Responsibility                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `packages/auth/src/oidc.ts`                   | Request-scoped provider loading, state generation, discovery-failure isolation                          |
| `packages/auth/src/index.ts`                  | Optional plugin composition, encrypted provider tokens, account-linking policy, disabled account routes |
| `packages/auth/src/constants.ts`              | Browser-safe `OIDC_PROVIDER_ID` (`oidc`)                                                                |
| `packages/config/src/server.ts`               | `WEAVER_OIDC_*` schema and `getOidcProvider`, including all-or-none configuration                       |
| `apps/web/src/env.ts`                         | Next adapter and runtime completeness validation                                                        |
| `apps/web/src/server/auth/index.ts`           | Passes server configuration to `createWeaverAuth`                                                       |
| `apps/web/src/app/(auth)/login/page.tsx`      | Request-time provider label; only the display name crosses into client props                            |
| `apps/web/src/app/(auth)/login/LoginForm.tsx` | Social sign-in, pending/error UI, safe return URL, explicit navigation                                  |
| `apps/web/tests/integration/oidc.spec.ts`     | Real Better Auth and Prisma against a local signing OIDC fixture                                        |
| `docs/setup.md`                               | Operator setup, exact Authentik redirect URI, lifecycle limitations                                     |

For shared session, ban, password-change and membership boundaries, read
`weaver-auth`; for environment parsing/deployment changes, read
`weaver-env-deploy`.

## Provider settings and identity

`WEAVER_OIDC_DISCOVERY_URL`, `WEAVER_OIDC_CLIENT_ID`, and
`WEAVER_OIDC_CLIENT_SECRET` must be set together. Optional
`WEAVER_OIDC_DISPLAY_NAME` defaults to `OpenID Connect`. Keep all four server-side;
never expose the client secret through `NEXT_PUBLIC_*`, serialized props, logs,
or redirect query parameters. Discovery accepts HTTPS or loopback HTTP.
A persisted `auth.oidc` setting overrides environment values, including when disabled.
Saved settings activate on the next request without restarting web. Environment edits
still require recreation of the web process. The login page uses `connection()`
and the effective settings reader, exposing only the provider display name.

The button label, Authentik application slug and fixed Weaver provider ID are
independent. Presentation changes should change only the display name. Accounts
are keyed by verified issuer plus immutable subject (`Account.issuer` and
`Account.accountId`), not by email, button label, or provider name. Replacing an
issuer or changing the subject mapping requires an intentional identity migration;
do not silently remap existing accounts. No new schema is needed for ordinary
provider configuration.

## Login and callback contract

Installed Better Auth 1.7 uses
`authClient.signIn.social({ provider: OIDC_PROVIDER_ID, ... })` and
`<AUTH_URL origin><base path>/api/auth/callback/oidc`. Under `/weaver`, register
`https://host.example/weaver/api/auth/callback/oidc` as the exact strict Authentik
redirect URI. Older examples using `signIn.oauth2`, `genericOAuthClient`, or
`/oauth2/callback/oidc` do not match this installed API. Inspect the installed
OAuthProvider types and callback source before applying upstream examples after upgrades.

Keep authorization-code PKCE S256, nonce binding and `openid profile email`.
`oidcProvider.ts` verifies the ID token through the shared verifier before
decoding its profile; it requires an ID token and strictly boolean
`email_verified: true` before returning a whitelisted profile. Merely enabling
Better Auth's `requireEmailVerification` is insufficient: it may persist/link an
account before denying a session, and a previously verified local account can
pass its gate. Do not decode an unverified token on an alternative callback path.

The client sets `disableRedirect: true` and navigates once using the returned
URL, because Weaver disables the default fetch redirect plugin. Preserve
`oauthProviderClient()` and the signed `oauth_query` when initiating sign-in;
it resumes MCP authorization at Weaver's consent page after the OIDC callback.
Both success and error URLs must carry the base path. Success destinations go
through `safeLoginCallbackUrl`; error returns preserve the original signed
query but render fixed, safe copy rather than provider error descriptions.

## Account lifecycle

- First login creates a normal `User`, without a local password or shared-project
  membership. The usual personal workspace is created on entry. Ignore provider
  role/group/password-change claims.
- A reserved `@weaver.invalid` email returns no profile; the machine domain is never
  provisioned or linked.
- Verified matching email may link an existing account. Preserve local profile,
  role, memberships, bans, and `mustChangePassword`; do not whitelist the provider
  as trusted to bypass email verification or allow different-email linking.
  `requireLocalEmailVerified: false` deliberately permits the strictly verified
  OIDC email to link admin-created accounts, whose local email starts unverified;
  do not restore the Better Auth default without covering that creation path.
- Access and refresh tokens are encrypted by Better Auth using `AUTH_SECRET`,
  independently of `WEAVER_ENCRYPTION_KEYS`; ID tokens remain signed JWTs
  stored in the account row. Unused provider token and manual linking/unlinking
  endpoints remain disabled in `DISABLED_ACCOUNT_PATHS`.
- Logout clears Weaver only (`createEndSessionURL` returns null). Authentik logout or
  deactivation does not revoke an existing Weaver session; Weaver's ban/session
  controls and session expiry still apply. Back-channel logout is not implemented.
- The OIDC before hook resolves an immutable snapshot for sign-in/callback and
  returns a request-local socialProviders array; never mutate the singleton
  context. `addOAuthServerContext` binds its generation to verified state, which
  code exchange checks before sending credentials. Label edits and key rotation
  preserve the generation; material edits and disable invalidate older flows.
- Static/environment fallback discovery is lazy, bounded, and retryable after a
  failure. Persisted enabled settings carry validated metadata; login-page and
  ordinary session/password requests do not fetch discovery. Discovery, JWKS,
  and token exchange use the pinned outbound policy and bounded JSON reader.
- Direct client-submitted ID-token sign-in is disabled; only state-bound code
  flows are accepted. Issuer replacement with linked OIDC accounts is rejected.
- Migration `20261018090000_oidc_account_issuer_guard` makes Account issuer writes
  take the same settings advisory lock and recheck the persisted issuer. Keep
  this database guard: an admitted callback can otherwise insert its first
  account after provider replacement. Both transaction orderings have regression tests.
- The first environment-to-database save always creates a fresh generation;
  cached environment metadata cannot establish equivalence across processes.
  Later label edits compare only canonical authentication metadata, sorting
  signing algorithms and excluding informational capability lists and warnings.

## Focused verification

Follow `weaver-testing` for the guarded database pair and test tiers. Apply
`pnpm db:test:migrate` before the database-backed specs. Use:

```sh
pnpm test:integration apps/web/tests/integration/oidc.spec.ts apps/web/tests/integration/auth.spec.ts apps/web/tests/integration/passwordChangeGate.spec.ts
pnpm exec vitest run -c apps/web/vitest.config.ts 'apps/web/src/app/(auth)/login/LoginForm.test.tsx'
pnpm --filter @weaver/config test
pnpm check
```

The OIDC fixture signs tokens locally and enforces client credentials, redirect
URI and PKCE at token exchange. Extend it for identity/provisioning, ban,
verification, base-path or consent changes; never contact a real Authentik server
from tests. Component tests exercise callbacks and markup, not browser layout.
Run root `pnpm test` for cross-package imports and skill-path/symlink validation.
Maintain this skill, `docs/IMPLEMENTATION.md` and the setup guide when the
integration contract changes.

## Database settings administration

`services/oidcSettings.ts` owns admin read/test/update and persists `auth.oidc`
in SystemSetting with optimistic revisions and an AES-GCM secret envelope.
`services/oidc/credentials.ts` participates in all runtime startup key checks
and secrets:rotate; key rotation preserves the authentication generation.
Startup validates the secret envelope without parsing non-secret metadata;
unavailable keys remain fatal, while malformed provider fields fail OIDC closed.
`config/oidcDiscovery.ts` shares a five-second, 256 KiB discovery/JWKS checker
between Test and activation. The `oidc` tRPC router is admin-only.

Administration > Settings > OIDC uses `OidcSettingsForm` with RHF drafts and
revision guards. Blank secret retains the saved credential. Test sends only the
unsaved URL, clears previous results, and ignores responses after any URL edit.
Discovery success does not verify the client secret or finish a sign-in. Save
revalidates metadata and immediately updates the effective login configuration.
