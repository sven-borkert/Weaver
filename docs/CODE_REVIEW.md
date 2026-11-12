# Weaver — Application Code Review

The original review below describes `31f9edee`. The [resolution record](#resolution-record) tracks re-verification and fixes; baseline findings are preserved for comparison.

|              |                                                                                                                                                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Date**     | 2026-11-12                                                                                                                                                                                                                    |
| **Revision** | `main` @ `31f9edee` (v0.1.238)                                                                                                                                                                                                |
| **Scope**    | Whole application: 3 runtimes (`web`, `agent-worker`, `mcp-server`), 11 shared packages, ~280k lines of TypeScript source, 143 migrations, 143 integration specs                                                              |
| **Method**   | Eight parallel domain reviewers (read-only), each reviewing against `docs/IMPLEMENTATION.md` and the area skills in `.claude/skills/`, plus independent re-verification of the top findings and objective lint/typecheck runs |

## Executive summary

Weaver is an unusually well-engineered codebase for its version number. All eight
domain reviews independently concluded that the security primitives, authorization
model, Git consistency machinery, job fencing, and test/deployment guards are
deliberate, fail-closed, and backed by real tests. **No Critical (exploitable
security hole or confirmed data-loss path in normal operation) was found in any
domain.** The residual risk concentrates in three places:

1. **The boundary with Git-supplied content** — glob pathspecs, merge-blind and
   non-NUL-framed history parsing weaken deleted-content recovery and can, under
   a diverged pull merge, delete the wrong files.
2. **Scaling with history size** — trust-ledger reads, rebuild, and recovery
   scans are linear in commit count while holding the project lock.
3. **Operational parity** — CI never runs the DB-backed suites, and the generic
   deployment example lags behind the quickstart's own security posture.

The most user-visible defect is a cross-table completion race in the table
editor that can silently discard unsaved edits.

### Objective checks (run during this review)

| Check                    | Result                                                          |
| ------------------------ | --------------------------------------------------------------- |
| `pnpm lint`              | ✅ 0 errors, 12 warnings (unused vars/imports in `@weaver/web`) |
| `pnpm typecheck`         | ✅ all 14 tasks pass                                            |
| Integration / e2e suites | Not run (Tier 3 — requires consent; see CI gap in §8)           |

### Findings overview

| Domain                               | Critical | Important | Minor  |
| ------------------------------------ | -------- | --------- | ------ |
| 1. Auth & security                   | 0        | 1         | 3      |
| 2. tRPC & web API                    | 0        | 2         | 8      |
| 3. Git store & content               | 0        | 6         | 8      |
| 4. Jobs, ingestion & scheduled tasks | 0        | 1         | 8      |
| 5. AI, assistant, wiki & knowledge   | 0        | 0         | 4      |
| 6. Database layer                    | 0        | 2         | 5      |
| 7. Frontend                          | 0        | 4         | 8      |
| 8. Infra, deploy & testing           | 0        | 3         | 8      |
| **Total**                            | **0**    | **19**    | **52** |

Findings are marked **CONFIRMED** (code read and behavior verified, some
empirically reproduced in scratch repos) or **SUSPECTED** (mechanism reasoned,
not reproduced end-to-end).

### Top priorities (synthesized across domains)

1. **Git pathspec & framing hardening** (§3.1–3.3): literal pathspecs for
   `rm`/`mv`, `--diff-merges=first-parent` on change-log helpers, `-z` framing
   for name-status parsing. One pass, three data-safety fixes.
2. **Key `TableScreen` by `tableId`** (§7.1): eliminates a confirmed race that
   discards another table's unsaved draft.
3. **Pre-authentication rate limiting on the machine API** (§1.1) and
   **per-credential limits on `/api/transfer/*`** (§2.2): the two entry points
   that lag the otherwise-consistent admission-control story.
4. **Batch `exam.listAttempts` lookups** (§2.1): ~201 queries per page today.
5. **Distinguish singleton dedup from publication failure** (§4.1): stops false
   housekeeping alarms during ingestion incidents.
6. **Close the CI parity gap** (§8.1): nightly guarded integration job against
   a pgvector service container.
7. **History-scaling pass** (§3.4–3.6): cached trust ledger, batched rebuild,
   bounded recovery scan.
8. **Transcript stick-to-bottom + conditional approval polling** (§7.2–7.3).
9. **Deployment example hardening + dind TLS** (§8.2–8.3).
10. **Operational resilience** (§6.1–6.2): monitor Git-in-transaction budgets;
    playbook for concurrent index builds on large tables.

---

## 1. Authentication & authorization

**Scope:** `packages/auth`, `packages/core/src/security`, `packages/mcp` gate/HTTP
pipeline, `apps/mcp-server`, web auth routes, OIDC, remote-instance OAuth,
machine API (`packages/core/src/projectApi`, `/api/v1/projects`).

### Strengths

- **Fail-closed credential policy reads.** After api-key verification,
  `resolveVerifiedCredentialContext` re-reads permissions/enabled/restrictions
  in one SQL statement (`packages/core/src/security/bearer.ts:146-174`), closing
  the mid-request revocation TOCTOU.
- **Multi-layered OAuth revocation.** Exact live consent generation,
  scope/resource containment, JTI denylist, refresh-family liveness
  (`bearer.ts:215-297`); a DB trigger guarantees the consent reference is never
  empty, so a missing claim matches nothing.
- **Global Admin is genuinely not a content superuser.** Non-members get
  `NOT_FOUND` including Admins (`projectAccess.ts:83-97`); the membership-rescue
  escape hatch can never target your own membership (`users.ts:644-649`).
- **DPoP done correctly:** DB-backed replay store, `htu` checked against the
  canonical resource URL (never proxy headers), EdDSA-only, pinned
  issuer/audience/typ (`packages/mcp/src/gate.ts:142-147`,
  `packages/auth/src/bearer.ts:286-329`).
- **Machine API:** SHA-256 digests + `timingSafeEqual`, strong `If-Match`
  preconditions, succeeded-receipt replay re-authorizes against current policy;
  machine attribution never impersonates the key creator.
- Dangerous Better Auth surfaces (admin impersonation, api-key HTTP, dynamic
  client registration, session-minted JWTs) are deliberately disabled
  (`packages/auth/src/index.ts:83-158`); `mustChangePassword` containment is
  consistent across tRPC, SSE, uploads, and downloads.

### Issues

#### Important

**1.1 Machine API has no pre-authentication rate limiting (DoS asymmetry).** — CONFIRMED _(re-verified)_
`apps/web/src/server/projectApi/dispatch.ts:49-55` calls
`resolveProjectMachineContext` (a Postgres `findUnique` on `ProjectApiKey`) for
every request before any throttle; `admitProjectMachineRequest` runs only after
a key authenticates. The MCP endpoint, by contrast, charges source/anon
limiters _before_ an unverified header can pick a bucket
(`packages/mcp/src/http.ts:235-268`). An unauthenticated flood of bogus
`wvr_project_` tokens turns each request into a DB round-trip with no
in-process brake.
_Fix:_ add a source-address/missing-credential sliding-window limiter charged
before `resolveProjectMachineContext`, mirroring the MCP pipeline; add a
regression test analogous to the MCP admission tests.

#### Minor

- **1.2 OIDC email-based linking trusts the IdP's `email_verified`.** — SUSPECTED (documented trade-off). `packages/auth/src/index.ts:228-235` + `oidcProvider.ts:110-118`. If the IdP ever marks an attacker-controlled address verified, an OIDC login links into the victim's local account. Accepted trust assumption per `weaver-oidc`; document it as a deployment precondition and consider an audit event on cross-provider links.
- **1.3 Machine-key existence timing oracle.** — CONFIRMED, negligible impact. `packages/core/src/security/projectMachine.ts:39-44` skips the digest when the key id is absent; the 122-bit random id makes enumeration infeasible. Optional dummy constant-work comparison.
- **1.4 In-process rate limiters assume a single instance.** — CONFIRMED (documented). `packages/core/src/security/rateLimit.ts:8-14`. Horizontal scaling would silently weaken anon/source buckets; note the constraint in deployment docs or back them with shared storage before scaling out.

**Verdict:** Excellent posture; no exploitable authorization hole found. Future
risk is more likely from _new_ call-sites forgetting access checks than from
the primitives — consider a test that enumerates project-scoped services and
asserts each resolves access.

---

## 2. API contract layer (tRPC + REST)

**Scope:** `apps/web/src/server/api/**` (33 routers), REST handlers under
`apps/web/src/app/api/**` except auth/v1.

### Strengths

- **Uniform service-layer authorization.** Every project-scoped procedure
  traced delegates to `resolveProjectAccess`/`assertProjectRole`; entity-only
  inputs derive the project before asserting; non-members get `NOT_FOUND`
  (existence hidden), role shortfalls `FORBIDDEN`. No global-Admin bypass.
- **Deliberate, tested error contract.** `coreError.ts` + `errorFormatter` lift
  `field`/`conflicts`/`headCommitSha`; `errorPrivacy.ts` scrubs production 5xx
  detail; behavior pinned by unit tests.
- **Transport hardening:** same-origin enforcement, streaming 16 MiB body cap,
  batch ≤ 20 (`http-transport.ts`, `sameOrigin.ts`).
- **Exemplary REST downloads:** access re-checked on 304 paths, FORBIDDEN
  collapsed to 404, `nosniff` + CORP, sanitized Content-Disposition, per-user
  concurrency slots with abort-aware cleanup, `?at=` SHA ancestry validation.
- **Uploads authorize before bytes reach disk**, with disk budgets, magic-byte
  sniffing, staged abort, and durable-then-publish with explicit 503 +
  reconciliation.

### Issues

#### Important

**2.1 N+1 in `exam.listAttempts` — up to ~201 queries per page.** — CONFIRMED _(re-verified)_
`packages/core/src/services/examAttempts.ts:505-507` loops `listItem` per row;
`listItem` (`:415-422`) issues `user.findUniqueOrThrow` **and**
`project.findUniqueOrThrow` per attempt plus a full snapshot parse. With
`limit` up to 100, a trainer opening the attempts list fires ~200 extra point
queries.
_Fix:_ batch-load users/projects with `findMany({ where: { id: { in: … } } })`
and parse only the title field needed for the list view.

**2.2 Transfer REST endpoints bypass the MCP rate limiter and buffer up to 64 MiB of JSON.** — SUSPECTED (requires a valid `mcp:use` credential)
`apps/web/src/app/api/transfer/documents/route.ts:19` and
`transfer/tables/route.ts:16` use `readBoundedJson`
(`apps/web/src/server/transfer/body.ts:9-29`), accumulating the whole body then
`JSON.parse`ing it; cap is 64 MiB
(`packages/core/src/services/remoteInstances/receive.ts:35`).
`resolveTransferActor` uses `resolveMcpPrincipal`, which does not apply the
per-key sliding-window limiter the MCP HTTP pipeline applies. A credential
holder can issue concurrent 64 MiB POSTs (~2–3× memory after parse) with no
throttle — 4× the tRPC body cap.
_Fix:_ per-credential limiter on the transfer routes; reconsider the cap or
stream the parse.

#### Minor

- **2.3 Unbounded cursor strings.** `schemas/externalMcp.ts:12,27`, `schemas/scheduledTask.ts:37` — every other cursor is capped (400–2048 chars). Add `.max(…)`.
- **2.4 `table.list` accepts `pageSize: -1` → unbounded result set.** `schemas/table.ts:140` → `services/tables.ts:2063-2081` omits `take`. Metadata-only, low impact; cap the "all" mode.
- **2.5 `project.list` has no pagination or cap.** `routers/project.ts:16-18` → `services/projects.ts:64-80`. Bounded by membership count today; unbounded by contract.
- **2.6 `toTRPCError` discards the CoreError stack.** `apps/web/src/server/api/coreError.ts:11-16` sets `cause = error.details`, so production 5xx diagnostics record the adapter stack, not the service throw site. Keep the CoreError as `cause`; read `.details` in the formatter.
- **2.7 `assistant` router duplicates `actorOf` and inlines schemas.** `routers/assistant.ts:26-33,70,144` vs `actor.ts:3-10` / `schemas/assistant.ts`. Drift risk; import the shared modules.
- **2.8 `diagnostics.getRetentionSettings` skips the AsAdmin convention.** `routers/diagnostics.ts:70-72` — `adminProcedure` gates it, so consistency/defense-in-depth only.
- **2.9 `scheduledTask.outputFolderPath` doesn't reuse `folderPathSchema`.** `schemas/scheduledTask.ts:18` — the service's `assertSafeSegments` compensates; transport validation is inconsistent and errors surface later.
- **2.10 `csp-report` uses one global rate-limit bucket.** `app/api/csp-report/route.ts:4,8` — any client can exhaust it and suppress legitimate reports. Key per IP.

**Verdict:** Unusually mature contract layer; no confirmed security gaps. The
N+1 and the transfer-endpoint hardening are the only substantive items.

---

## 3. Git storage & content domain

**Scope:** `packages/git-store`, `packages/core/src/documents|tables|editor`,
content services (contentOperations, projectMetadata, images, review, rebuild).

### Strengths

- **Advisory locking is genuinely well-engineered** (`advisoryLock.ts`):
  server-side `lock_timeout` + checkout deadline, writer turn queue, reader
  admission chain that releases the turn on acquisition so readers overlap;
  connection loss aborts Git subprocesses; `assertHeld` rechecks before
  commit/ref publication; failed sessions discarded. Backed by multi-process
  tests.
- **Fail-closed idempotency & attribution.** Caller text can never forge
  `Weaver-*` trailers (`gitStore.ts:424-430`, tested); recovery requires a
  verified identity or returns `IDEMPOTENCY_KEY_REUSED`/`CONFLICT`; trust is
  ledger-based, remote identity claims rejected; commit success survives
  ledger I/O failure via pending-ledger reconciliation.
- **Careful recovery:** lstat+realpath `.git` validation, symlink-skipping
  traversal, fresh-lock rejection by mtime, `reset --hard`/`clean -fdx` only
  under the exclusive lock. Interrupted `commit-tree`→`update-ref` cannot lose
  published work.
- **Strong pull-merge design:** symlink/gitlink rejection before worktree
  reset, id-based conflict resolution, single-parent prepare commit, worktree
  rollback, no network under the content lock, fenced leases with post-commit
  outcome recovery.
- **Pinned-SHA read discipline is consistent** in traced paths; projection
  drift is treated as repairable (reconcile enqueue + ownership-scoped
  convergence), not fatal.

### Issues

#### Important

**3.1 `repo.rm`/`rmDir`/`mv` use glob pathspecs — demonstrated wrong-file deletion.** — CONFIRMED primitive; merge reachability reasoned _(re-verified)_
`packages/git-store/src/gitStore.ts:684-695` passes paths to `git mv`/`git rm`
without `--literal-pathspecs` or `--`. Reproduced in a scratch repo:
`git rm -q 'foo[1].md'` deletes **both** `foo1.md` and `foo[1].md`. Direct
exposure: the pull-merge deletion loop
(`projectGitRemoteMerge.ts:765-772`) calls `repo.rm(file)` on ancestor-tree
paths — remote-adopted names like `notes[final].md` are legal Git content
Weaver explicitly tolerates. A diverged/force-pushed remote history can make
the loop glob-delete unrelated sibling files and commit the loss.
Service-originated paths are canonical slugs, so everyday UI writes are safe —
but the primitive contradicts the codebase's own literal-pathspec discipline
(`checkoutPathsFrom` at `gitStore.ts:1347`). **Highest-priority item in this
review; borderline Critical given the data-loss mechanism.**
_Fix:_ add `--literal-pathspecs` and `--` to `rm`, `rmDir`, `mv`, and the
pathspecs in `lastCommitForPath`/`logForPath`; add a glob-metacharacter
regression test mirroring `gitStore.test.ts:1134`.

**3.2 Merge-commit file changes are invisible to recovery and activity scans.** — CONFIRMED (git behavior reproduced) _(re-verified)_
`logSince` (`gitStore.ts:1199-1220`) and `logChangesBefore` (`:1221-1245`) run
`git log --name-status` without `--diff-merges`, while `logChangesForShas`
(`:1295`) correctly uses `--diff-merges=first-parent`. A merge commit emits no
change entries by default, so documents/tables deleted by a diverged pull
merge never appear as `D` records: `content_history mode=deleted` /
`listDeletedContent` (`contentRecovery.ts:163-203`) cannot find them. This
silently defeats a data-safety feature for a whole class of deletions.
_Fix:_ add `--diff-merges=first-parent` to both helpers; test recovery of a
pull-merge deletion.

**3.3 Name-status paths are not NUL-framed: C-quoted and space-edged names misparse.** — CONFIRMED (quoting reproduced)
`parseChangeLog` (`gitStore.ts:286-334`) and `logForPath`'s status parsing
(`:1165-1170`) split `--name-status` output on newlines/tabs without `-z`. Git
C-quotes non-ASCII/special characters (`"caf\303\251.md"`); the parser never
unquotes, and `line.trim()` (`:310`) corrupts paths with leading/trailing
spaces. Remote-adopted files with such names get wrong paths in the activity
feed and are silently skipped by deleted-content recovery — contrary to the
skill's "NUL-framed history safe for unusual names" claim.
_Fix:_ use `-z` and parse NUL-framed paths (as `listHistoricalPaths` already
does), or decode C-quoting; stop trimming path columns.

**3.4 Trust ledger is read in full on every history call and grows without bound.** — CONFIRMED
`trustedCommits` (`gitStore.ts:618-629`) reads both ledger files and builds a
Set; invoked by every `logForPath`/`logSince`/`logChangesBefore`/
`logChangesForShas`/`firstParentTrustedBefore`. `readCommittedFileAt`
(`:926-938`) — used by **every `getDocument`** — pays a full ledger read+parse
just for `baseCommitSha`. At 100k commits: ~4 MB read + 100k-line Set per
document fetch.
_Fix:_ cache the Set per repo keyed by file mtime/size (append-only under the
lock), or load lazily only when entries carry identity trailers; consider
compaction.

**3.5 Rebuild holds the shared lock across O(files) Git subprocesses, starving writers.** — CONFIRMED structure; magnitude estimated
`rebuildIndex` (`documents.ts:2031-2067`) runs per file: `blobSizeAt` +
`showFileAt` + `logForPath --follow -n 1` (each a subprocess, each re-reading
the ledger per 3.4), plus a per-row ownership walk for wiki pages. A few
thousand documents → tens of thousands of subprocesses under the reader lock;
writers meanwhile hit the 10 s timeout and get `BUSY`. Post-pull rebuilds
(`projectGitRemoteJobs.ts:676-679`) make this automatic.
_Fix:_ batch head-entry discovery, reuse one ledger load, chunk the lock hold
or yield to writers between batches.

**3.6 Create/lifecycle recovery walks full history per operation.** — CONFIRMED pattern
`recoverPriorOperation` (`contentOperations.ts:844-851`) and
`recoverLifecycleOperation` (`:779-786`) run
`git log -n 11 --grep=Weaver-Operation-Id:…`. For a fresh operation id there
are no matches, so Git walks the **entire** history reading every message — on
every MCP/proposal create and lifecycle action, before the normal write.
_Fix:_ bound the walk (`--since`/first-parent trusted window) or keep an
operation-id side index checked before the Git scan.

#### Minor

- **3.7 `.git` containment check only inspects the first segment.** `gitStore.ts:248-255` allows `a/.git/config`; service-level `assertSafeSegment` blocks it today — defense-in-depth gap in the layer that owns containment. Reject `.git` at any position.
- **3.8 Activity fallback uses the unsafe `--since` cutoff.** `projectActivity.ts:73-86` — SUSPECTED; date cutoffs prune backdated side-branch commits. Reuse the ancestry-range helpers (`wikiReads.ts:341-348` shows the safe pattern).
- **3.9 Rename-freed paths are not reserved by slug allocation.** `listHistoricalPaths` uses `--diff-filter=D` (`gitStore.ts:870-888`); renames emit `R100`, so a new document can reuse a path another document renamed away from, splicing `--follow` history. Include rename sources in the reserved set.
- **3.10 Trust-ledger crash window & non-atomic merge append.** `gitStore.ts:630-649` — a crash between commit and append leaves the commit permanently untrusted (safe but unrecoverable without manual surgery); a torn append can concatenate lines. Write pending first (fsync), ensure trailing newline, document a re-trust procedure.
- **3.11 Asymmetric trust defaults in `resolveAttribution`.** `documents.ts:601-609` accepts `trustedAuthor !== false` for user trailers while wiki requires `=== true` (`:648-654`). Latent: a future caller passing unscored entries would trust remote trailers. Require `=== true` everywhere or make the field required.
- **3.12 `gitFor` replaces the child environment entirely.** `gitStore.ts:463-471` — Git runs without `PATH`/`HOME`/`GIT_CONFIG_NOSYSTEM`; the resolved binary can differ from the one `gitVersion.ts` checks, and system gitconfig still applies. Spread a minimal sane env as `remote.ts:126-141` does.
- **3.13 Case-sensitivity collisions on pull are unchecked.** `projectGitRemoteMerge.ts:407-410` — SUSPECTED, deployment-dependent (macOS dev): `Foo.md` vs `foo.md` phantom diffs. Detect and re-slug, or document Linux-only pull support.
- **3.14 `deleteRef(PULL_REF)` failure is swallowed.** `projectGitRemoteMerge.ts:820` — stale transient ref contrary to the cleanup invariant. Log to diagnostics instead of dropping.

**Verdict:** Well-hardened layer with no confirmed critical data-loss path in
normal operation. Issues 3.1–3.3 form one "Git-supplied names" hardening pass;
3.4–3.6 are the difference between working at 1k and 100k commits. Consider a
fault-injection test suite (kill between `commit-tree`/`update-ref`, mid-ledger
append, mid-phase-B) and an explicit "literal pathspec / NUL framing" contract
section in the `weaver-git-store` skill.

---

## 4. Background jobs, ingestion & scheduled tasks

**Scope:** `packages/core/src/jobs|runtime|scheduledTasks|ingestion`,
`apps/agent-worker`, `packages/ingestion`. pg-boss semantics verified against
the installed `pg-boss@12.28.0` source.

### Strengths

- **Clean publisher/consumer ownership split.** Web starts a send-only
  publisher; consumers/cron registered exclusively by the worker; post-stop
  enqueues fail loudly instead of booting an unmanaged instance.
- **Durable intent always precedes publication** (uploads, manual retry, Git
  push queueToken with rollback + backoff).
- **Rigorous claim/attempt fencing:** conditional `updateMany` transitions
  guarded by `baseAttemptCount` + claim job id/retry count; duplicate/stale
  deliveries ack as no-ops; a replaced worker cannot publish.
- **Finite, snapshot-fenced recovery** (24-attempt exhaustion, full-snapshot
  recheck, 60-min cooldown derived from the longest lease).
- **Correct defensive shutdown:** drain watchdog, queue drains before Prisma
  disconnects, pg-boss `error` events captured, 40 s budget heads off pg-boss's
  30 s cap.
- **Crash-safe scheduled-task publication** with Git-trailer acknowledgement
  recovery; ticks claim under a task-row lock; owner ban/password flags read
  live at lease time.
- **Strong resource/SSRF bounds:** DNS-pinned fetch, isolated parser child with
  heap cap/RSS watchdog/deadline/SIGKILL, OCR budgets, authorize-before-disk
  multipart, heartbeat/expiring upload reservations.

### Issues

#### Important

**4.1 Singleton dedup (`null`) is conflated with publication failure — false `system.reconcile` failures during ingestion outage/backlog.** — CONFIRMED _(re-verified)_
`packages/core/src/jobs/ingestionHandlers.ts:118-128` reserves a stale file,
then `if (!jobId) throw new Error("ingestion recovery job publication failed")`.
But pg-boss `createJob` returns `null` when the singleton key is already
outstanding (verified in `pg-boss@12.28.0` `manager.js:781-808`). Recovery
re-reserves an already-pending file every cooldown, so when the ingestion
worker is down/backlogged >60 min, each 15-min reconcile pass re-publishes,
gets `null` (the job is legitimately queued), and throws — marking the whole
`system.reconcile` job failed and flooding diagnostics precisely during an
incident. Same conflation yields misleading user errors at
`routers/ingestion.ts:71` and false "could not queue" warnings at
`packages/ingestion/src/publish.ts:10`, `parseStage.ts:296-309`,
`analyzeStage.ts:315-326`. No data is lost.
_Fix:_ classify `requestKnowledgeJob` outcomes as `accepted | deduped | failed`;
treat `deduped` as success everywhere; reserve errors for actual throws.

#### Minor

- **4.2 `task.run` taskId singleton blocks new dispatch up to 20 min after a crash.** `jobs/types.ts:213-215,83` — CONFIRMED mechanism; run-now then throws the wrong message ("Background jobs are disabled"). Key by `runId` and correct the error text.
- **4.3 `runTaskTick` is not failure-isolated per task.** `scheduledTasks/tick.ts:16-23` — SUSPECTED; one corrupt cron/timezone row stalls all claims _and_ expiry until the next minute. Per-item try/catch.
- **4.4 `system.reconcile` has no overlap guard.** No singleton key, concurrency 2, 15-min cron vs 60-min lease — SUSPECTED; safe-but-wasteful overlap. Singleton key or concurrency 1.
- **4.5 Worker with `WEAVER_JOBS_ENABLED=false` is a silent, healthy no-op.** `apps/agent-worker/src/index.ts` + `runtime.ts:665,759` — CONFIRMED; container reports ready with no consumers. Fail startup or log loudly.
- **4.6 Health endpoint 404s on any query string.** `apps/agent-worker/src/health.ts:18` — CONFIRMED; `/health?x=1` fails some probes. Compare `URL.pathname`.
- **4.7 Docling error path leaves the response body unconsumed.** `packages/ingestion/src/docling.ts:97-102` — SUSPECTED socket retention with per-request Agents. `await response.body?.cancel()` on non-ok; consider a shared Agent.
- **4.8 Memory watchdog kills the parser child when memory is unmeasurable.** `packages/core/src/process/memoryMonitor.ts:64-66` — CONFIRMED logic; macOS `ps` timeouts cause spurious failures (Linux `/proc` path is reliable). Tolerate transient measurement errors.
- **4.9 UTF-16 `.slice` can split astral characters in stored error messages.** `scheduledTasks.ts:1496`, `diagnostics/reference.ts:19,24` — CONFIRMED, cosmetic; truncate by code point per the documented discipline.

**Verdict:** Unusually mature, defensively-engineered subsystem. Confirmed
issues are observability false-positives and edge-case robustness — not
correctness or security bugs.

---

## 5. AI, assistant, wiki & knowledge graph

**Scope:** `packages/ai`, `packages/assistant-tools`,
`packages/core/src/assistant|wiki|knowledge|ai|externalMcp`,
`packages/external-mcp`.

### Strengths

- **SQL injection structurally excluded:** every knowledge/search query
  parameterized; the only raw fragment is the vector type cast, gated by an
  integer range check; vectors bind via `pgvector.toSql`.
- **SSRF protection is real:** DNS validation of all answers, address pinning
  (defeats rebinding TOCTOU), manual redirects; external MCP additionally
  rejects cross-origin redirects and caps hops.
- **Credentials write-only, encrypted (AES-256-GCM + AAD + key versioning),
  resolved per-request** with live endpoint/provider/enabled re-checks;
  diagnostics scrub bearer/key material from captured bodies/paths/hosts.
- **Auto-approve cannot be widened by the model:** allowlist excludes
  restore/lifecycle; acceptance re-locks attempt→run→conversation and re-checks
  live attempt, pinned project, current setting, role, and principal.
- **External MCP dispatch is once-only and digest-bound:** re-authorize under
  lock, re-validate against the reviewed schema, re-discover the catalog to
  reject swapped tool definitions; approval ciphertext cleared on
  denial/expiry/settlement.
- **Hostile catalogs are cost-bounded:** expanded-node caps, local-only `$ref`,
  cycle rejection, RE2 for remote regexes.
- **Citations re-derived from Git, not trusted from the model;** wiki agent
  tightly fenced (operation union, run-id-only ids, per-page/per-run budgets
  under the project lock, guide/source protection).
- **Deletion propagates correctly** through mentions/evidence/chunks/embeddings;
  runaway protection layered (byte budgets checked every step, step caps,
  wall-clock timeouts, lease fences, usage accounting on every terminal path).

### Issues

No Critical or Important findings. The reviewer specifically tried to break
scope isolation, auto-approve, external dispatch authorization, and SQL/vector
safety and could not.

#### Minor

- **5.1 External MCP results capped in characters, not UTF-8 bytes.** `packages/external-mcp/src/client.ts:238-257` — CONFIRMED; native tools use a 16,000-byte budget, so a CJK-heavy external result can be ~48 KB and fail a run with `CONTEXT_LIMIT` that would otherwise fit. Clamp with the same `utf8Prefix` byte budget; add a CJK regression test.
- **5.2 Graph citation validation skips active-generation/live-mention filters.** `packages/core/src/assistant/citations.ts:435-467` vs `graph.ts:496-502` — CONFIRMED divergence; surfaces stale data within an authorized project (access still checked). Reuse the active-entity/live-mention predicate.
- **5.3 Citation revision fallback can scan every tracked file.** `citations.ts:146-157` — CONFIRMED code, SUSPECTED impact; N+1 Git-read cliff on unusual path mismatch. Cap candidate files or resolve via a path-at-SHA index.
- **5.4 Assistant runner can throw from `finally` on usage-accounting failure.** `packages/ai/src/runner.ts:485-491` — CONFIRMED asymmetry (wiki runner guards the identical call). Make the final persist best-effort; consider a shared helper across all three runners.

**Verdict:** Approve. Trust boundaries are enforced server-side with layered
checks; the four findings are hardening/consistency items on an already strong
baseline.

---

## 6. Database layer

**Scope:** `packages/db` (schema, 143 migrations, client factory, bootstrap),
seeds, cross-cutting access patterns (soft delete, raw SQL, transactions).

### Strengths

- **Soft delete enforced centrally and consistently:** `notDeleted` in
  `resolveProjectAccess` and every sampled list/read; raw-SQL read models route
  through `visibleProjectsSql`; search/graph joins repeat the filter. No
  soft-deleted-project leak found in a hot path.
- **Raw SQL parameterized everywhere;** the single `Prisma.raw` fragment is
  range-gated before interpolation.
- **Thoughtful pgvector indexing:** partial HNSW per dimension, `halfvec` above
  2,000 dims, matching search casts, exact-search fallback by design.
- **Disciplined migrations:** strictly ordered, forward-fix instead of editing
  history, partial unique indexes for business invariants, CHECKs Prisma can't
  express; the one `NOT NULL` without default targets a same-migration table.
- **Safe seeds/bootstrap:** idempotent natural-key upserts, guarded bootstrap,
  env-sourced admin password with minimum length.
- **Clean client boundary:** only `packages/db` + harnesses construct clients;
  factory pins UTC/pool/statement timeout; OAuth cutover enforces quiescence +
  lock ordering.

### Issues

#### Important

**6.1 Git I/O runs inside open DB transactions holding the membership advisory lock.** — CONFIRMED pattern, SUSPECTED impact
`createProject` performs Git init via `syncProjectMetadata` inside the
transaction (`packages/core/src/services/projects.ts:134-165`);
`withKeyPolicyLock` wraps a DB transaction + membership lock inside the Git
repo lock, allowing a Git commit inside the tx
(`projectApiKeys.ts:319-325`, 60 s budget). Deliberate and timeout-bounded with
consistent Git→DB lock order (low deadlock risk), but DB connection and
advisory-lock hold time are coupled to filesystem latency; slow storage can
exhaust the 10-connection pool or stall membership writes.
_Fix:_ keep Git steps minimal, monitor tx duration/pool saturation, move Git
work outside the transaction wherever the invariant allows.

**6.2 Every index build is blocking; no `CREATE INDEX CONCURRENTLY` in any of the 65 index-creating migrations.** — CONFIRMED
E.g. `20260920000100_dashboard_read_indexes/migration.sql:1-3`. `migrate deploy`
can run with the app up, so a future index on a large hot table
(`Document`, `DocumentSearchChunk`, `KnowledgeEmbedding`) takes
`ACCESS EXCLUSIVE` and blocks writes for the build. Acceptable pre-1.0; a real
upgrade-downtime risk at scale.
_Fix:_ `CONCURRENTLY` (outside Prisma's per-migration transaction) for large
tables, or a documented maintenance window.

#### Minor

- **6.3 Statement timeout defaults to disabled.** `packages/config/src/server.ts:90` (`DATABASE_STATEMENT_TIMEOUT_MS` default 0) — a runaway query can hold a pool connection indefinitely. Consider a nonzero default.
- **6.4 `project.findUniqueOrThrow` without `notDeleted` in exam history.** `examAttempts.ts:419-422` — SUSPECTED intentional (history outlives soft delete); add a comment so nobody "fixes" it into a bug or copies the pattern.
- **6.5 `project.findUnique` without `notDeleted` in task context assembly.** `scheduledTasks/context.ts:290-293` — CONFIRMED no leak (access check throws first); consistency nit.
- **6.6 Bootstrap client skips the factory's session settings.** `packages/db/prisma/bootstrap-admin.ts:26` — low impact; route through `createPrismaClient`.
- **6.7 Destructive cleanups in historical migrations.** `20260902090000` (`DELETE FROM "User"`), `20261001160000` — CONFIRMED but one-time, pre-release, documented; noted as reviewed, no action.

**Verdict:** Well-engineered; remaining risks are operational rather than
correctness bugs. Run the documented `migrate diff` drift check in CI.

---

## 7. Frontend

**Scope:** `apps/web/src/app` (auth + workspace route groups),
`apps/web/src/components`, `lib`, tRPC client. Largest components read fully;
the rest swept for pattern violations.

### Strengths

- **XSS defense in depth, verified end to end:** KaTeX `trust: false` + size
  caps, Mermaid `securityLevel: "strict"`, Tiptap Link protocol allowlist,
  image src scheme/path rejection, URL-cell validation, open-redirect-safe
  login callback. The only `dangerouslySetInnerHTML` sites are these guarded
  renderers.
- **Session/principal correctness:** principal-keyed QueryClient retired on
  change; session expiry keeps drafts mounted with re-login in a new tab; 4xx
  never retried.
- **Comprehensive unsaved-changes guard:** capture-phase link interception,
  popstate/history-point tracking, beforeunload, programmatic
  `confirmNavigation` boundary, sign-out prompt suppression.
- **Excellent editor state machinery:** revision-CAS draft reducer, retired-SHA
  set, draft preservation on save/refresh/conflict; table save double-submit
  guard and draft export on conflict.
- **Deliberate accessibility:** roving-focus explorer, quantized `aria-live`
  announcer, keyboard-navigable graph outline beside the `aria-hidden` canvas.
- **Hygiene:** timers/listeners/SSE/object URLs/cytoscape cleaned up; polling
  mostly visibility-gated; forms follow zodResolver + `applyTrpcErrorToForm`.

### Issues

#### Important

**7.1 Table save/restore completion can silently discard a different table's draft.** — CONFIRMED _(re-verified)_
`TableScreen.tsx:286-289` (save) and `:346` (restore) call
`setLatestEditorState({ tableId: variables.tableId, ...accepted })`
unconditionally; the callback (`:113-121`) has no identity guard. Unlike every
other detail route, `tables/[tableId]/page.tsx` renders `TableScreen`
**unkeyed**, so the component survives table-to-table navigation. Sequence:
save table A → navigate to table B through the dirty guard → edit B → A's save
resolves and overwrites B's draft with A's accepted state. B's edits vanish
without confirmation. Violates the skill's rule that completion callbacks must
target `variables` identity, never the currently rendered entity.
_Fix:_ `key={tableId}` the screen like the other detail routes (cheapest,
removes the whole class); optionally also guard the callback with
`current?.tableId === variables.tableId`.

**7.2 Transcript force-scrolls to bottom on every streamed delta.** — CONFIRMED _(re-verified)_
`apps/web/src/components/assistant/Transcript.tsx:177-179` —
`scrollIntoView` runs whenever message count or live text length changes; no
near-bottom check exists. Reading history while a run streams is effectively
impossible.
_Fix:_ shared stick-to-bottom hook (scroll only when near bottom; optional
"jump to latest" affordance) with a unit test.

**7.3 Resolved external-tool approvals poll every 5 s forever.** — CONFIRMED _(re-verified)_
`ExternalToolApprovalCard.tsx:78-81` uses unconditional
`refetchInterval: 5_000`; settled transcripts keep rendering the last run's
cards, so every approved/denied/expired card polls for as long as the
conversation stays open. Cost grows linearly with history and never stops.
_Fix:_ `refetchInterval: (q) => q.state.data?.status === "pending" ? 5_000 : false`.

**7.4 Exam timer announces to screen readers twice per second.** — CONFIRMED
`AttemptTimer.tsx:23,33-36` — `role="timer"` (which defaults to
`aria-live="off"` for exactly this reason) is overridden with
`aria-live="polite"` on a 500 ms re-render, constantly competing with question
content.
_Fix:_ remove `aria-live`; announce milestones (5 min / 1 min) via a separate
quantized live region, mirroring `Transcript.tsx`.

#### Minor

- **7.5 Run-outcome acknowledgment loop has no backoff or ceiling.** `AssistantProvider.tsx:198-231` — SUSPECTED 1 Hz poll for the shell's lifetime if the outcome never persists. Backoff + attempt cap settling into the error presentation.
- **7.6 Conversation rename: pending-disable closes the editor and hides field errors.** `AssistantConversation.tsx:111-127,61-70` — CONFIRMED; disabling a focused input fires blur → form unmounts → server field error renders nowhere. Use `readOnly` while pending; reject empty titles client-side.
- **7.7 Explorer access errors don't use the nonsensitive not-found presentation.** `ContentExplorerScreen.tsx:404-415` — CONFIRMED; FORBIDDEN/UNAUTHORIZED look like transient failures inviting retries. Branch on `isQueryAccessError`.
- **7.8 Exam list ticks every second with nothing to count down.** `TraineeExamList.tsx:16-20` — CONFIRMED waste; enable the interval only when a row needs it.
- **7.9 Git remote card polls every 5 s while idle.** `GitRemoteCard.tsx:79-82` — CONFIRMED; poll fast only while a job is active.
- **7.10 Task output-document search fires a query per keystroke.** `TaskDialog.tsx:156-166` — CONFIRMED; reuse the 200–250 ms debounce pattern used elsewhere.
- **7.11 `useSearchParams` without Suspense in shell components.** `WorkspaceBreadcrumbs.tsx:96`, `EventsPanel.tsx:250-255` — CONFIRMED convention gap; works only because routes are forced dynamic. Wrap in `<Suspense>`.
- **7.12 Conversation switching drops unsent composer text without confirmation.** `AssistantPage.tsx:57-76,93-97` — CONFIRMED small UX gap; lift drafts into the provider or confirm before discarding.

**Verdict:** Mature, security-conscious, remarkably consistent with its own
conventions. Fixing the four Important items brings tables/assistant/exams up
to the standard of the rest of the app. Also consider windowing the unpaged
`folder.tree` explorer before thousand-document folders become a complaint.

---

## 8. Infrastructure, deployment & testing

**Scope:** `packages/config`, Dockerfiles/compose stacks, `deploy/`, `scripts/`,
CI (`.gitlab-ci.yml`, `.github/workflows`), test harness mechanics, repo
hygiene.

### Strengths

- **Defense-in-depth against destructive test/dev mix-ups:** `require-env.mjs`
  - in-process `testEnvironment.ts` re-checks (including symlinked data dirs)
    before any TRUNCATE/rm; both unit-tested.
- **Fail-closed secret/config validation:** placeholder `AUTH_SECRET` rejected,
  production requires HTTPS `AUTH_URL`, strict key-ring parser, quickstart
  generates all secrets randomly (no default credentials).
- **Docker hygiene well above average:** non-root + tini in all images, tools
  target never derived from the `COPY . .` builder, CI smoke tests fail the
  build on internal-path leaks and launch Chromium to prove tracing includes;
  Postgres pinned with base OS for collation stability.
- **Release pipeline safety:** immutable-tag overwrite refusal, serialized
  releases, SHA-pinned actions, token via `--password-stdin`, build script
  tested with a stub docker.
- **Test harness quality:** single-fork sequential integration with per-test
  `resetDb()` incl. pg-boss partition cleanup, real Better Auth, deterministic
  loopback mock AI/MCP servers, e2e against a real production build + worker +
  MCP, role-based selectors with essentially no arbitrary sleeps; 132
  integration specs covering all 33 routers.
- **Dependency hygiene:** security-critical deps exact-pinned, corepack pinned
  with sha512, frozen lockfile everywhere, pnpm 24-hour `minimumReleaseAge`
  supply-chain delay active with an auditable exclude list.
- **Operational scripts:** shared deploy lock, quiesced verified backups with
  `git fsck` and verify-before-prune, upgrade pins resolved SHA and keeps a
  rollback image set. **Repo hygiene clean:** no committed secrets, data dirs,
  or test artifacts (verified via `git ls-files`).

### Issues

#### Important

**8.1 CI never runs the integration or e2e suites — pipeline/local parity gap.** — CONFIRMED _(re-verified)_
`.gitlab-ci.yml:42-46` and `.github/workflows/build-images.yml:34-37` run only
`pnpm check`, `format:check`, and `pnpm test` (scripts + unit). The 132
DB-backed specs and Playwright suite exist only behind the local Tier-3
consent gate; the Docker smoke test checks file presence, not behavior against
PostgreSQL. A merge to `main` can pass CI while breaking migrations, auth, or
job behavior. (`playwright.config.ts:50` even has CI retry logic that can never
trigger.)
_Fix:_ a scheduled (nightly) or manually-gated CI job with a
`pgvector/pgvector:0.8.6-pg17-trixie` service running the guarded integration
suite against `weaver_test`; keep PR pipelines at Tier 1.

**8.2 Generic deploy example publishes plain HTTP on all interfaces.** — CONFIRMED config, SUSPECTED real-world impact
`deploy/examples/docker-compose.yml:58-59,145-146` bind ports without a
loopback address while `web.env.example:4,15` set `NODE_ENV=production` with
`AUTH_URL=http://localhost:3000`. The quickstart deliberately binds loopback
"because the stack serves plain HTTP"; this example — presented in
`docs/setup.md:588-604` as the single-host path — has no such guard or TLS
note. Run as-is on a server it exposes credentials and session cookies in
cleartext on every interface; the localhost `AUTH_URL` also breaks
non-loopback access.
_Fix:_ default binds to `127.0.0.1:` like quickstart, or add an explicit
"requires a TLS reverse proxy; set AUTH_URL to the public HTTPS origin"
warning in both example files.

**8.3 GitLab dind exposes an unauthenticated Docker API over TCP.** — CONFIRMED _(re-verified)_
`.gitlab-ci.yml:53-58` runs dind with `--tls=false --host=tcp://0.0.0.0:2375`
and empty certdir. Anything reaching the build network gets full Docker
control in a job holding registry push credentials. Per-build network
isolation limits exposure (hence Important, not Critical).
_Fix:_ default TLS certdir (`DOCKER_TLS_CERTDIR: "/certs"`, port 2376,
`DOCKER_TLS_VERIFY: 1`) or a socket-binding runner.

#### Minor

- **8.4 Example compose worker healthchecks use liveness, not readiness.** `deploy/examples/docker-compose.yml:87,120` probe `/health`; production uses `/ready`. Switch.
- **8.5 Skill drift: `WEAVER_ARTIFACT_MAX_FILE_BYTES`.** `.claude/skills/weaver-env-deploy/SKILL.md:190` says 268,435,456; parser + `.env.example` use 536,870,912. Update the skill; consider a script test comparing skill tables to parser defaults.
- **8.6 Floating Node base images.** `node:22-alpine` in all three Dockerfiles, `node:22` in CI — contradicts the stated pinning rationale (Postgres/Rust are pinned). Pin by digest or minor.
- **8.7 Real-time sleeps in a few integration specs.** `knowledgeIndex.spec.ts:1308` (deliberate 5.5 s lock hold), `scheduledTaskExternalInputs.spec.ts:527`, `wikiRunner.spec.ts:462-464`, `oauthConsents.spec.ts:967` — SUSPECTED flake impact on loaded machines. Prefer event-driven waits where the contract allows.
- **8.8 Test-reset guards accept hostname `postgres`.** `testEnvironment.ts:22`, `require-env.mjs:66` — SUSPECTED; DNS search domains could resolve it remotely. Resolve and require loopback, or restrict the alias.
- **8.9 `start-database.sh` sources `.env` as shell and floats the dev image.** Lines 17-19, 54, 74 — dev-only t3-oss pattern; parse via dotenv, bind-check `127.0.0.1`, pin the image to the compose tag.
- **8.10 Test caller context cast `as never`.** `apps/web/tests/integration/_harness.ts:380` — context drift invisible to `tsc`. Type against the real `Context`.
- **8.11 Expensive-test guard fails open on malformed hook input.** `scripts/guard-expensive-tests.mjs:14-16` — by design; keep the framing that it is a workflow gate, not a safety boundary.

**Verdict:** Unusually well-hardened infrastructure for v0.1.x. The meaningful
gaps are operational: CI parity, the deploy example's posture, and dind TLS.
Also schedule a manual backup-restore rehearsal — the backup script is
unit-tested but never exercised against a real host.

---

## Cross-cutting recommendations

1. **One "Git-supplied names" hardening pass** (3.1–3.3) with regression tests
   for glob/Unicode/space-edged filenames and a pull-merge deletion recovery
   test; add the literal-pathspec/NUL-framing contract to the
   `weaver-git-store` skill.
2. **One admission-control pass** (1.1, 2.2): pre-auth source limiting on the
   machine API, per-credential limiting on transfer routes, plus the small
   schema sweep (unbounded cursors, `pageSize: -1`).
3. **One history-scaling pass** (3.4–3.6): cached/compacted trust ledger,
   batched rebuild reads, bounded recovery scans — with tx-duration and
   pool-saturation monitoring (6.1).
4. **One polling/UX pass** (7.2, 7.3, 7.5, 7.8–7.10): a shared
   `pollWhile(predicate, ms)` helper and stick-to-bottom hook would make these
   uniform and prevent the next unconditional `refetchInterval`.
5. **Classify job-publication outcomes** (`accepted | deduped | failed`) once
   and reuse everywhere (4.1, 4.2).
6. **Extend "architecture as tests" to documentation drift** (8.5): a script
   asserting skill-table defaults against the env parser would have caught the
   artifact-size drift automatically.
7. **Fault-injection tests for the Git recovery invariants** (kill between
   `commit-tree`/`update-ref`, mid-ledger append, mid-merge-phase-B) — the
   machinery is complex enough that reasoned verification should be backed by
   injected failure.

## Methodology & limitations

- Eight domain reviewers ran in parallel, each read-only, each instructed to
  read `docs/IMPLEMENTATION.md` and the matching area skills first, cite
  file:line for every finding, and distinguish CONFIRMED from SUSPECTED.
  Reviewers did not dispatch further agents.
- Several Git behaviors (glob pathspec deletion, merge-commit name-status
  silence, C-quoting, rename `D`-filter exclusion) were **empirically
  reproduced in scratch repositories** by the git-store reviewer; pg-boss
  singleton semantics were verified against the installed package source.
- The coordinator independently re-verified the top findings: gitStore
  pathspecs and change-log helpers, `TableScreen` completion callbacks +
  unkeyed page, Transcript auto-scroll, approval polling, ingestion dedup
  throw, exam N+1, machine-API dispatch order, and CI job scripts.
- `pnpm lint` (0 errors / 12 warnings) and `pnpm typecheck` (all pass) were run
  during the review. **Integration and e2e suites were not run** (Tier 3
  consent gate); findings about runtime behavior at scale are reasoned from
  code, not load-tested.
- Reviews sampled intelligently rather than exhaustively: ~280k lines cannot
  be read line-by-line in one pass. Absence of a finding in an area is not a
  guarantee of absence of defects.
- No files were modified by the review other than this document.

---

## Resolution record

Re-verified and addressed for v0.1.239 on 2026-11-12. All 71 numbered findings
were assessed against the implementation. “Documented” means the verified constraint is retained with
explicit operating guidance, rather than an unverified claim of a code defect.
The final verification results are recorded below this table.

| Finding | Resolution and evidence                                                                                                                                                                                                                                                                   |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1     | Added pre-authentication source admission to machine API dispatch; rotating bogus credentials cannot create fresh buckets. Exact previously verified tokens receive bounded admission and still reauthenticate live authority.                                                            |
| 1.2     | Documented the IdP's verified-email ownership requirement in setup and the OIDC skill. Linking remains an explicit provider trust boundary.                                                                                                                                               |
| 1.3     | Missing machine keys perform the same digest comparison against a dummy digest.                                                                                                                                                                                                           |
| 1.4     | Documented process-local limits and shared edge enforcement before horizontal scaling.                                                                                                                                                                                                    |
| 2.1     | Exam pages batch trainee/project metadata and parse only snapshot titles; batching regression counts queries.                                                                                                                                                                             |
| 2.2     | Transfer routes share credential quotas; body reads reserve two slots per user and eight per process, released in finally. Compatible 64 MiB payload cap retained.                                                                                                                        |
| 2.3     | External-MCP and scheduled-task cursors have 2,048-character caps.                                                                                                                                                                                                                        |
| 2.4     | Table “All” mode returns at most 200 rows with continuation pages and checked offsets.                                                                                                                                                                                                    |
| 2.5     | Public project lists cap at 1,000 with deterministic ordering; internal authorization enumeration remains complete.                                                                                                                                                                       |
| 2.6     | tRPC retains CoreError as cause; the formatter reads its details, preserving field metadata and the original stack.                                                                                                                                                                       |
| 2.7     | Assistant router uses the shared actor helper and extracted schemas.                                                                                                                                                                                                                      |
| 2.8     | Retention reads use getRetentionSettingsAsAdmin, including a service-level authorization check.                                                                                                                                                                                           |
| 2.9     | Task output folders reuse folderPathSchema.                                                                                                                                                                                                                                               |
| 2.10    | CSP admission buckets use trusted client addresses; untrusted forwarded headers cannot manufacture buckets. Direct deployments use a shared fallback.                                                                                                                                     |
| 3.1     | Mutation/history paths are literal and option-terminated; real-Git glob-name regressions cover deletion and history.                                                                                                                                                                      |
| 3.2     | Change readers include first-parent merge diffs.                                                                                                                                                                                                                                          |
| 3.3     | Name-status parsing uses NUL framing and preserves unusual names and rename sources.                                                                                                                                                                                                      |
| 3.4     | Bounded per-repository trust caches use ledger stat signatures; old trusted history remains available.                                                                                                                                                                                    |
| 3.5     | Rebuild batches blobs/history against one immutable HEAD outside the shared lock, retains canonical per-path history for merged ancestry, then rechecks HEAD before projecting under the lock.                                                                                            |
| 3.6     | An incremental, serialized operation-ID index avoids repeated full scans while retaining old idempotency receipts. A cold process still performs one full scan.                                                                                                                           |
| 3.7     | Every path segment rejects .git, case-insensitively.                                                                                                                                                                                                                                      |
| 3.8     | Activity fallback uses pinned ancestry ranges rather than date-pruned Git traversal.                                                                                                                                                                                                      |
| 3.9     | Slug reservation includes rename-source paths.                                                                                                                                                                                                                                            |
| 3.10    | Pending trust is fsynced before ref publication; ledger reconciliation preserves line boundaries and syncs the directory before removing pending state. The skill documents legacy re-trust.                                                                                              |
| 3.11    | User and wiki attribution both require trustedAuthor === true.                                                                                                                                                                                                                            |
| 3.12    | Git inherits a minimal explicit environment with runtime PATH and disabled system/global Git configuration.                                                                                                                                                                               |
| 3.13    | Pull validation rejects case/Unicode path collisions before resetting the worktree.                                                                                                                                                                                                       |
| 3.14    | Failed pull-ref cleanup emits git.remote.pull_cleanup_failed while preserving the accepted operation outcome.                                                                                                                                                                             |
| 4.1     | Publication distinguishes accepted, deduped and disabled outcomes; exceptions represent failure. Ingestion treats existing singleton jobs as successfully queued.                                                                                                                         |
| 4.2     | task.run singleton identity is runId; unavailable and disabled queues have distinct messages.                                                                                                                                                                                             |
| 4.3     | Claims and dispatches isolate task failures; stale-run dispatch and expiry still execute after earlier tick failures. A real corrupt-cron regression reproduced the old failure.                                                                                                          |
| 4.4     | Each worker consumes system.reconcile with concurrency one; cross-worker maintenance continues to rely on its existing database fences.                                                                                                                                                   |
| 4.5     | Workers refuse startup when jobs are disabled.                                                                                                                                                                                                                                            |
| 4.6     | Worker probes compare URL pathname, accepting query strings.                                                                                                                                                                                                                              |
| 4.7     | Docling cancels non-success response bodies before throwing.                                                                                                                                                                                                                              |
| 4.8     | Memory monitoring tolerates two consecutive measurement failures, resets on success, and still immediately enforces a measured overrun.                                                                                                                                                   |
| 4.9     | Stored task and diagnostic errors truncate by Unicode code point.                                                                                                                                                                                                                         |
| 5.1     | External results share a UTF-8 byte budget across text and structured content; CJK/emoji regressions cover boundaries.                                                                                                                                                                    |
| 5.2     | Graph citations require active-generation entities and live mention provenance.                                                                                                                                                                                                           |
| 5.3     | Citation revision fallback batches bounded blobs instead of starting Git processes per tracked file.                                                                                                                                                                                      |
| 5.4     | Final assistant usage persistence is best-effort; a real runner fault regression preserves completed output.                                                                                                                                                                              |
| 6.1     | Necessary Git/DB transaction coupling is retained; five-second slow-transaction diagnostics and pool/transaction monitoring guidance make the storage-latency cost observable.                                                                                                            |
| 6.2     | Corrected the review's lock claim: ordinary CREATE INDEX takes SHARE, blocking writes, not ACCESS EXCLUSIVE. Setup documents maintenance windows and dedicated concurrent-index migrations without explicit transactions, rehearsed with pinned Prisma. Applied history is unchanged.     |
| 6.3     | Database statement timeout defaults to 30 seconds; explicit zero remains an operator opt-out.                                                                                                                                                                                             |
| 6.4     | Re-verification found existing access checks already reject deleted projects. Batched metadata now repeats notDeleted; the regression proves inaccessible history while retaining attempt records.                                                                                        |
| 6.5     | Scheduled-task context metadata repeats notDeleted.                                                                                                                                                                                                                                       |
| 6.6     | Administrator bootstrap uses the shared UTC/pool/statement-timeout client factory.                                                                                                                                                                                                        |
| 6.7     | Reviewed historical one-time cleanup migrations; retained unchanged as the original finding requested.                                                                                                                                                                                    |
| 7.1     | TableScreen is keyed by tableId, isolating pending completions across navigation.                                                                                                                                                                                                         |
| 7.2     | Shared stick-to-bottom behavior preserves a reader's scroll position during streaming.                                                                                                                                                                                                    |
| 7.3     | External approval cards poll only while pending.                                                                                                                                                                                                                                          |
| 7.4     | Exam timers keep per-tick output silent and announce time milestones separately.                                                                                                                                                                                                          |
| 7.5     | Run-outcome acknowledgement retries back off and stop at a bounded ceiling with a visible error.                                                                                                                                                                                          |
| 7.6     | Pending conversation rename is read-only instead of disabled; empty titles fail locally.                                                                                                                                                                                                  |
| 7.7     | Explorer access failures use the nonsensitive access-error presentation.                                                                                                                                                                                                                  |
| 7.8     | Exam lists tick only while attempts need a countdown.                                                                                                                                                                                                                                     |
| 7.9     | Git cards poll only while push or pull work is queued/running.                                                                                                                                                                                                                            |
| 7.10    | Task output-document search is debounced.                                                                                                                                                                                                                                                 |
| 7.11    | Shell search-parameter consumers have Suspense boundaries.                                                                                                                                                                                                                                |
| 7.12    | Conversation drafts live in the provider and survive conversation switches.                                                                                                                                                                                                               |
| 8.1     | Added nightly/manual guarded integration CI with an isolated loopback pgvector service and Chromium. Local full-suite consent remains required.                                                                                                                                           |
| 8.2     | Generic deployment HTTP ports bind loopback; example and setup explain TLS and public HTTPS auth origin.                                                                                                                                                                                  |
| 8.3     | GitLab dind uses TLS on 2376; setup documents the required per-job runner certificate volume.                                                                                                                                                                                             |
| 8.4     | Both example workers probe readiness.                                                                                                                                                                                                                                                     |
| 8.5     | Deployment skill artifact limit now matches the parser's 536,870,912 bytes.                                                                                                                                                                                                               |
| 8.6     | Node Docker/CI images pin 22.23.5 and a base OS instead of floating major tags.                                                                                                                                                                                                           |
| 8.7     | Wiki heartbeat and task-period waits observe state. OAuth already polls actual lock state; the knowledge test deliberately exceeds the original five-second lock timeout and retains that duration. Integration reset hooks share a 60-second budget so unfinished resets do not overlap. |
| 8.8     | Destructive test/provisioning guards accept loopback hosts only, rejecting the ambiguous postgres alias and host-routing overrides.                                                                                                                                                       |
| 8.9     | Dev database startup parses dotenv as data, checks 127.0.0.1, and pins the pgvector image.                                                                                                                                                                                                |
| 8.10    | Removed the test-caller as-never escape hatch; TypeScript checks the real caller context.                                                                                                                                                                                                 |
| 8.11    | Retained malformed-hook fail-open behavior and explicitly labeled the guard a workflow gate; independent database/data-directory guards remain fail-closed.                                                                                                                               |

### Fix verification

- `pnpm check`: passes (14 lint and 14 typecheck tasks; two pre-existing lint warnings).
- `pnpm test --concurrency=1`: passes, 5,686 tests (5,529 package tests and 157 script/mock-server tests).
- Approved full integration run: 2,580 passed and 32 failed across 132 specs. Failures exposed a no-op commit regression, stale fixture assumptions and reset-hook timeouts; the seven affected specs then passed all 383 tests on rerun. Combined coverage is 2,612 integration tests across all 132 specs, with every reported failure resolved.
- `pnpm format:check`: changed files pass; three pre-existing untracked notes fail formatting (`docs/superpowers/plans/2026-11-02-wiki-agent.md`, `docs/superpowers/specs/2026-11-02-wiki-agent-design.md`, `wsl-network-after-zscaler.md`). Those unrelated files are preserved.
- Independent backend and UI review caught and closed merge-lineage attribution, transient trust-cache errors, late saved-reply duplication and draft-revision ownership regressions. No blocking review findings remain.

Test migrations were up to date before execution. No e2e/browser suite, production
deployment, CI-hosted run or load test was performed. The GitLab TLS runner volume
must be configured by its operator before using that build job.
