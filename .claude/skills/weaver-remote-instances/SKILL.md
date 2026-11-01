---
name: weaver-remote-instances
description: Use when changing Weaver peer-instance registration, per-user remote connections, OAuth callback/refresh/disconnect, or document/table send and receive endpoints. SSH Git remotes and external OIDC login are separate integrations.
---

# Weaver peer-instance connections and transfer

Sending content connects a local user to a registered peer with OAuth and creates
new content there. It is distinct from Git synchronization and from logging in
through an external identity provider.

## Entry points

| Path                                                        | Responsibility                                                                          |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/core/src/services/remoteInstances/registry.ts`    | Admin registry, safe public projections and peer OAuth client registration              |
| `packages/core/src/services/remoteInstances/connections.ts` | User authorization state, callback, encrypted tokens, serialized refresh and disconnect |
| `packages/core/src/services/remoteInstances/transfer.ts`    | Saved-content export, target discovery and sending                                      |
| `packages/core/src/services/remoteInstances/receive.ts`     | Validate incoming content and create local documents/tables                             |
| `packages/core/src/services/remoteInstances/types.ts`       | Runtime dependencies and shared transfer/appearance types                               |
| `packages/core/src/remotes/urls.ts`                         | Canonical peer base URL, client ID, scopes, audience and endpoint construction          |
| `packages/core/src/remotes/http.ts`                         | Bounded peer HTTP and classified errors                                                 |
| `apps/web/src/app/api/remotes/callback/route.ts`            | Browser callback adapter                                                                |
| `apps/web/src/app/api/transfer/`                            | Receiver HTTP adapters                                                                  |
| `apps/web/src/server/transfer/actor.ts`                     | Receiver bearer principal resolution                                                    |
| `apps/web/src/server/transfer/body.ts`                      | Streamed JSON byte bound                                                                |
| `apps/web/src/server/transfer/schemas.ts`                   | Transfer request validation                                                             |

Read `weaver-auth` for OAuth consent/bearer enforcement, `weaver-admin` for the
registry UI, and `weaver-documents`/`weaver-tables` for content conversion and
appearance portability. Use `weaver-env-deploy` for encryption-key rotation and
outbound network policy.

## Registration and identity

- Base URLs end at the instance root or its application base path, not an API
  route. Use `normalizeRemoteBaseUrl` and `remoteEndpoints`; preserve HTTPS,
  credential/query/fragment rejection and base-path-aware callback construction.
- Registry writes create the peer's `weaver-instance:<peer base URL>` OAuth
  client on this instance. Peers need reciprocal registration for authorization.
  Keep the public PKCE client, exact callback URI and enabled-state linkage.
- Use the existing MCP resource audience (`<peer base URL>/api/mcp`) and consent
  generation. Receiver authentication uses `resolveMcpPrincipal`; a transfer
  route must not invent a new audience, trust arbitrary user IDs, or bypass
  consent, bans, password-change restrictions or project access.
- Authorization state belongs to the signed-in initiating user and expires.
  Preserve callback-user and expiry checks when changing error navigation.
  Registration alone does not connect every user or grant project access.

## Token lifetime and concurrency

- Store per-user tokens encrypted with the versioned ring and
  `remote-instance-connection` AAD bound to the connection ID. Startup checks and
  rotation include these payloads; do not expose them in registry/account DTOs.
- Refresh locks the connection row and rereads tokens before contacting the
  peer. A parallel sender may already have refreshed; reusing its old refresh
  token can trigger the peer's theft detection and revoke the grant family.
- For HTTP failures during refresh, peer 400/401 refusal requires reconnect.
  An unreachable peer remains a transport failure; it must not silently
  disconnect the user. A transfer endpoint's 401 also requires reconnect.
  Reconnect uses `PRECONDITION_FAILED` with `details.field: "remoteInstanceId"`;
  temporary failures omit that field. The send dialog relies on this field,
  not just the error status or wording.
- Secret rotation uses ciphertext/version compare-and-swap so it cannot
  overwrite tokens refreshed concurrently. Callback atomically stores tokens
  and consumes authorization state; disconnect deletes connection/pending state.
  Neither has a general shared lock with callback/refresh. Preserve their actual
  transactions rather than assuming broader serialization.

## Transfer boundaries

- Send saved Git content, not unsaved browser state. Receive creates fresh local
  identity/history attributed to the receiving user and rechecks destination
  write permission. This is content transfer, not a replica of source IDs,
  history, memberships or permissions.
- Document cross-references flatten for transfer; only the source document's own
  assets travel. Preserve table value conversion and capability preflight for
  image-bearing appearance metadata. Use existing domain converters.
- Bound the receiver's body while streaming, independent of `Content-Length`.
  `TRANSFER_BODY_MAX_BYTES` is currently 64 MiB. Validate image names,
  duplicates, count, per-image size and sniffed MIME before creating content.
- Receiving creates new content. A lost response does not prove that the peer
  failed to commit; preserve explicit retry behavior rather than introducing
  automatic replay of a send.

## Verification

Use `weaver-testing` with injected peer HTTP and the guarded database:

```sh
pnpm test:integration apps/web/tests/integration/remoteInstances.spec.ts apps/web/tests/integration/remoteConnections.spec.ts apps/web/tests/integration/remoteSend.spec.ts apps/web/tests/integration/transferApi.spec.ts
```

Conversion tests live in
`packages/core/src/services/remoteInstances/transfer.test.ts`; bounded-body
coverage is `apps/web/src/server/transfer/body.test.ts`. Preserve concurrent
refresh, offline-versus-reconnect, user-bound callback, destination authorization,
image validation and committed-content tests. Do not contact a real peer from
unit or integration tests.

## Review hardening invariants

Construct post-transfer links from the configured remote base URL, target project, resource kind and encoded returned ID. Never trust reply.url for navigation.
