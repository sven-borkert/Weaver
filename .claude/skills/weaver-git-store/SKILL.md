---
name: weaver-git-store
description: Use when changing Weaver's shared Git repository primitives, committed snapshots, advisory locks, recovery, path containment, commit attribution/trailers, or SSH Git transport. Document/table behavior stays in their domain skills.
---

# Weaver Git storage foundation

Git owns saved content and history; PostgreSQL owns access and rebuildable
projections. This skill covers shared storage mechanics, not the application's
own development branches or worktrees.

## Entry points

| Path                                        | Responsibility                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `packages/git-store/src/gitStore.ts`        | Reader/writer facades, immutable blobs/history, commits, recovery and paths |
| `packages/git-store/src/advisoryLock.ts`    | Cross-process project locks, admission queues and lock-session lifetime     |
| `packages/git-store/src/remote.ts`          | Isolated SSH push/fetch and immutable network snapshots                     |
| `packages/git-store/src/remoteCommand.ts`   | Remote command lifetime and cancellation                                    |
| `packages/git-store/src/gitVersion.ts`      | Supported Git version and runtime-status cache                              |
| `packages/core/src/services/projectRepo.ts` | Core wrapper mapping lock timeout to retryable `CONFLICT`/`BUSY`            |

The package's public exports are `@weaver/git-store`, `/advisory-lock`, `/remote`
and `/version`. Read `weaver-documents` or `weaver-tables` for content formats,
projection rebuilds and domain concurrency; `weaver-jobs` for durable Git push/
pull claims; `weaver-env-deploy` for SSH trust and network policy.

## Choose the repository boundary

- `openProjectRepo` returns an unlocked immutable reader or null, without
  creating a repository or running recovery. For a multi-file read, capture
  one HEAD and read every blob at that SHA; repeated reads of moving HEAD can
  mix revisions even when each individual read is safe.
- `withExistingProjectRepoReader` holds the shared project lock and exposes
  the reader facade. Use it when the operation needs its existing shared-lock
  contract, such as history/diff coordination. It does not perform recovery.
- `withProjectRepo` takes the exclusive lock, ensures the repository and runs
  recovery before invoking its writer callback. `withExistingProjectRepo`
  takes the same lock/recovery path but returns null for missing repositories.
  Core services use their wrapper to preserve the public busy-error mapping.
- The reader is a runtime facade, not only a TypeScript restriction. Keep
  mutation and worktree methods out of `READER_KEYS`.

## Storage and locking invariants

- Normalize project UUID spelling through existing helpers. Storage remains
  under the paired `WEAVER_DATA_DIR` Git root. Use containment checks for every
  path; writes and worktree reads refuse symlinked components. Remote trees
  must not import symlinks or gitlinks.
- PostgreSQL session advisory locks protect the entire recovery/write/commit
  lifetime across processes. Preserve the per-project admission queue and
  shared/exclusive distinction. Lock waits use server-side `lock_timeout` and
  a checkout deadline rather than a polling loop.
- Losing the checked-out lock session aborts signal-aware `gitFor` subprocesses;
  some raw read helpers do not currently share that signal. Recheck lock
  ownership before publishing a commit/ref, release in `finally`, and discard
  failed sessions. A disconnected lock must not permit a later successful commit.
  Unlock failure is reported and discards the session without replacing the
  callback's result or original error.
- Recovery removes interrupted writer residue, including ignored files, only
  inside the locked data repository. It handles unborn HEAD, rejects fresh Git
  locks, validates the real `.git` directory, and disables attribute filters.
  Do not extend traversal into loose-object directories or follow symlinks.
- `readFileFromWorktree` reads committed HEAD despite its historical name.
  To test physical rollback residue, use filesystem reads inside the failing
  writer callback before another writer's recovery can clean it away.
- Keep binary reads byte-exact and bounded, literal pathspecs and NUL-framed
  history safe for unusual names, and commit messages/trailers separately
  validated. Operation provenance comes from the terminal trailer block.
  `sanitizeCommitMessage` strips every caller-authored `Weaver-*:` line (case-insensitive);
  real trailers come only from `commitAll` options and are appended afterwards.
  In `batchCatFile`, drain skipped oversized/non-blob payloads and retain request
  order and bounded buffering; skipping bytes incorrectly corrupts later blobs.
- `CommitAuthor` is a user or `{ kind: "machine", machineKind, machineId }`
  (`projectApiKey` → `Weaver-Project-Key-Id`, `wikiAgent` → `Weaver-Wiki-Agent-Id`, UUID
  validated). `commitAll` requires a wiki agent commit to carry operation id, run id
  and `wikiRequestHash`; a `wiki-revert:` commit carries the hash with a user author and no agent trailer. Adding a log field touches both positional formats
  (`CHANGE_LOG_FORMAT`, `logForPath`) and their field counts.
- User/machine attribution is trusted only for locally recorded commits in
  `.git/weaver-trusted-commits`. Remote trailers alone do not establish an
  author. Preserve distinct human and project-machine `CommitAuthor` variants.
- A remote push captures an immutable HEAD under the shared lock and releases
  it before networking. Never hold the content mutation lock over network I/O.
  Consult the Git remotes sections of `weaver-documents` for pull merge rules
  and `weaver-jobs` for the shared push/pull lease and follow-up dispatch.

## Verification

Follow `weaver-testing` for the guarded database and data root:

```sh
pnpm --filter @weaver/git-store test
pnpm test:integration apps/web/tests/integration/gitStore.spec.ts apps/web/tests/integration/gitStoreLocking.spec.ts
```

The locking spec uses real independent processes: retain same-project
serialization, different-project overlap and connection-death assertions. Remote
transport changes also use `projectGitRemote.spec.ts`,
`projectGitRemoteJobs.spec.ts` and `projectGitRemotePull.spec.ts` under
`apps/web/tests/integration/`. A unit mock alone cannot verify advisory-lock
release, process death, or a commit that must not occur after cancellation.

## Review hardening invariants

Once HEAD contains a commit, trust-ledger failure must not turn it into a failed write. The pending trust ledger is merged on a later successful append; all readers consider both ledgers.

## Ancestry ranges

`git log` orders by date, and dates in untrusted commits are attacker-controlled, so a date cutoff can end a walk before a backdated side-branch commit. For "changes since a time"
use `firstParentTrustedBefore(commitish, before)` (newest trusted first-parent commit older than the time), `listCommitShas(commitish, { exclude, maxCount })` (`rev-list`, so every commit
of `<boundary>..HEAD`) and `logChangesForShas(shas)` (order kept, `--diff-merges=first-parent` so merge commits show their file changes). A cursor is a sha found in the listed range; page by
slicing it rather than re-walking from the cursor, which would miss commits that are not its ancestors.
