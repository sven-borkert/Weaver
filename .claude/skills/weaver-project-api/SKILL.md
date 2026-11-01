---
name: weaver-project-api
description: Use when changing Weaver's /api/v1/projects machine API, project-owned API keys and grants, HTTP contracts, content publishing, revision preconditions, idempotent retries, attribution, or recovery after committed writes. Personal keys and MCP authentication are covered by weaver-auth.
---

# Weaver project machine API

This API grants a machine explicit actions on one project's content. Its principal
is a project/key pair, independent of a human account or session.

## Entry points

| Path                                             | Responsibility                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| `packages/core/src/projectApi/contracts.ts`      | Method/path/operation/request/response contracts                       |
| `packages/core/src/projectApi/schemas.ts`        | Strict input schemas and typed cells                                   |
| `packages/core/src/projectApi/credentials.ts`    | Secret minting/digests and current key resolution                      |
| `packages/core/src/projectApi/policy.ts`         | Resource/action authorization                                          |
| `packages/core/src/projectApi/folderIdentity.ts` | Durable folder UUIDs, root grants, ancestry                            |
| `packages/core/src/projectApi/operations.ts`     | Durable reservation, publication, replay and repair                    |
| `packages/core/src/projectApi/changes.ts`        | Normalize/validate content and derive action deltas before reservation |
| `packages/core/src/projectApi/operationLock.ts`  | Per-operation lock and separate connection pool                        |
| `packages/core/src/projectApi/queries.ts`        | Authorized content queries                                             |
| `packages/core/src/projectApi/cursors.ts`        | Cursor identity and revision binding                                   |
| `packages/core/src/security/projectMachine.ts`   | Machine principal without user identity                                |
| `packages/core/src/services/projectApiKeys.ts`   | Session-only key management                                            |
| `packages/core/src/services/contentAuthor.ts`    | Separate machine authorship                                            |
| `apps/web/src/server/projectApi/`                | HTTP admission, bounded bodies, dispatch and safe response mapping     |
| `apps/web/src/app/api/v1/projects/[projectId]/`  | Public route adapters                                                  |

Read `docs/api/project-api-agent-guide.md` for the client contract and durable
retry examples. Implementation changes also require `weaver-documents` or
`weaver-tables`; repository primitives use `weaver-git-store`.

## Authority and identity

- `wvr_project_` credentials never authenticate through personal-key, OAuth or
  MCP gates. Machine authority has no `userId`, global role or membership.
  Creator lifecycle changes do not revoke project keys.
- Management requires a session actor, Maintainer rank, and `content:write`;
  nonmembers, including Admins, get `NOT_FOUND`. Revocation is irreversible and
  changes `policyVersion`. Use current key/policy state on every request.
- Grants attach to durable resource/folder UUIDs, with explicit root grants.
  Folder UUIDs follow moves and renames. Duplicate folder identity mappings are
  excluded; a path prefix is not durable authority. No matching grant is
  `NOT_FOUND`; an available matching grant without the action is `FORBIDDEN`.
- Read, Create, Update and Delete are independent. Do not require Read for a
  write-only append. Table replacement derives additional Create/Delete needs
  from actual row, column and option deltas.
- Preserve `lastEditedByProjectKeyId` and the captured author name on rebuild;
  human edits/moves clear previous machine attribution. Do not impersonate the
  key creator in Git or content projections.

## Publishing and recovery

- Existing-resource writes require one quoted strong 40-hex `If-Match`: missing
  is HTTP 428 and stale is 412. Resource creation has no existing revision.
  Every mutation requires an `Idempotency-Key`; keep strict body schemas and
  safe error/receipt contracts aligned with `contracts.ts` and `respond.ts`.
- Lock order is operation lock → project repository lock → current policy
  recheck. Preserve the dedicated operation-lock pool; sharing a single-client
  repository/application pool can self-deadlock.
  Preserve `commitAll.beforeCommit` checks for cancellation and current key
  liveness, including writes added through a new operation.
- Hash identity binds the normalized command, method, project and `If-Match`.
  Reuse the same key only for the identical request. Reservation preserves
  generated resource, column and row IDs across retries.
- A succeeded receipt replay still reauthorizes against current policy and the
  resource's current location. Stored success must not revive revoked grants or
  reveal content moved outside authority.
- Git commits may succeed before receipt/projection settlement fails. Preserve
  committed content and use commit provenance to repair projections, indexing
  publication and the receipt on the identical retry, without a duplicate
  commit. Do not infer rollback from a failed database acknowledgement.
  Recovery verifies trusted key attribution, operation ID, request hash,
  operation kind and ancestry; ambiguous provenance is `CONFLICT`, not a
  reason to publish again.
- Pagination cursors bind key, policy version, HEAD, query and limit. Continue
  to charge the live-key/project rate counter before repository locks. Audit
  and retention live alongside operations; do not store plaintext key secrets.

## Verification

Use `weaver-testing` and select explicit Tier 1/2 specs from
`apps/web/tests/integration/`:

```sh
pnpm test:integration apps/web/tests/integration/projectApiPublishing.spec.ts apps/web/tests/integration/projectApiAccess.spec.ts apps/web/tests/integration/projectApiRoutes.spec.ts
```

Grant/folder changes also need `projectApiFolders.spec.ts`; credential changes
need `projectApiCredentials.spec.ts`; author changes need
`projectApiAttribution.spec.ts`. Colocated contracts/policy/credential
utilities run through `pnpm test`. Keep crash tests that fail immediately after
a real Git commit and retry the identical request after subsequent content
changes. Merely returning `replayed: true` does not prove projection repair or
absence of a second write.

## Review hardening invariants

Rate-limit upserts only advance the stored time window. Delayed requests from an older window are limited and cannot reset accounting.
