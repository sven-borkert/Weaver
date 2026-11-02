---
name: weaver-database
description: Use when touching the Weaver database layer — editing packages/db/prisma/schema.prisma, creating or applying Prisma migrations, using the @weaver/db APIs, writing seed scripts, working with soft-deleted projects, or debugging stale generated clients, weaver/weaver_test/weaver_e2e mix-ups, or notDeleted behavior.
---

# Weaver Database, Prisma & Migrations

The database package owns schema, migrations, generated client, seed, and
runtime client construction. Prisma always uses `@prisma/adapter-pg`;
migrations are hand-authored SQL applied with `migrate deploy` (never
`migrate dev`); project reads respect soft delete via the `notDeleted` spread.
Document rows are rebuildable projections of Git, not content truth.

## Key files

| Path                                          | Role                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/db/prisma/schema.prisma`            | Single schema; datasource block has no `url` line                                                                      |
| `packages/db/prisma.config.ts`                | CLI connection URL (`env("DATABASE_URL")`), schema, migrations, and seed hook                                          |
| `packages/db/src/client.ts`                   | Public singleton plus exports for `@weaver/db`                                                                         |
| `packages/db/src/factory.ts`                  | `PrismaPg` construction with pool max and statement timeout from `@weaver/config/server`                               |
| `packages/db/generated/prisma/`               | Package-internal generated client, gitignored; regenerate with `pnpm db:generate` or root `pnpm install`               |
| `packages/db/prisma/migrations/`              | `<UTC-timestamp>_<slug>/migration.sql`, hand-authored; `migration_lock.toml` lets `migrate diff --from-migrations` run |
| `packages/core/src/services/projectAccess.ts` | `notDeleted` spread (`{ deletedAt: null }`) and project access helpers                                                 |
| `packages/core/scripts/seed.ts`               | Dev + e2e seed: admin + four demo users + Demo Project; idempotent upserts; requires `DATABASE_URL` (no dotenv)        |

## Model reference

See `docs/IMPLEMENTATION.md` → Database and data model for the model map, including knowledge and ingestion. Prisma schema is canonical.

## Conventions

- Application and core consumers import the singleton from `@weaver/db` and
  generated types/client APIs from the public `@weaver/db/client` subpath,
  never `@prisma/client` or a relative generated path. Only package-internal
  files under `packages/db` import `packages/db/generated/prisma/` relatively.
  Every `PrismaClient` construction—runtime, seed, integration harness, and e2e
  global setup—passes the `PrismaPg` adapter.
- Never add `url` to the datasource block; the CLI reads
  `packages/db/prisma.config.ts`. Use the root `db:migrate`, `db:test:migrate`,
  and `db:e2e:migrate` scripts so the database package loads the matching env.
- Three databases (`weaver`/`weaver_test`/`weaver_e2e`) — CLAUDE.md "Three databases" is authoritative; follow it exactly.
- IDs: normally `String @id @default(uuid()) @db.Uuid`; `Document.id` and `DataTable.id` come from canonical Git files and have no generated default. FK scalars use `@db.Uuid` plus explicit relations except the intentional `DocumentLink.targetDocumentId` no-FK projection; typed links use the three-field composite identity. No `@@map` on any model — `resetDb()` TRUNCATEs by `Prisma.ModelName` (`apps/web/tests/integration/_harness.ts`).
- Add an explicit `@@index` for every FK you filter/join on — Postgres does not auto-index FKs (see `Member.@@index([userId])`).
- Soft delete: `Project.deletedAt` is the only soft-delete column so far. Live reads use `findFirst` + `...notDeleted` (`packages/core/src/services/projectAccess.ts`), never `findUnique` — `resolveProjectAccess` is the canonical reader. New soft-deletable entities: add `deletedAt` + `@@index`, spread `notDeleted` on reads, and exclude them in lists.
- Document projection: Git is authoritative. `document.rebuildIndex` diffs/upserts Document rows to preserve dependent chunks for unchanged files, replaces outgoing links, and invalidates keyword readiness for restored projection rows. Never delete all Document rows as a rebuild shortcut or treat projections as document history.
- `DocumentLink.targetDocumentId` has no FK so unresolved crossrefs remain indexed, inbound links survive target deletion, and a restored target revives without rewriting sources. Every target/backlink lookup must use a target-type-specific project-scoped join through `Document` or `DataTable`; never query target ids bare.
- Transactions: `db.$transaction(async (tx) => ...)`; queries on `tx` run sequentially — no `Promise.all` (one pg connection per tx; fine on `db`).
- Timestamps: `DateTime` maps to `timestamp(3)` without time zone holding UTC wall-clock. Prisma writes UTC, so raw queries and live PL/pgSQL trigger bodies must write `UTC_NOW` (`packages/core/src/services/sql.ts`, `timezone('UTC', now())`) and set `createdAt` explicitly instead of relying on `DEFAULT CURRENT_TIMESTAMP`; the PostgreSQL session time zone is not UTC on every host (a Europe/Berlin dev server stored local wall-clock two hours off).
- Raw `timestamptz` reads (including pg-boss) project `AT TIME ZONE 'UTC'`
  before Prisma decoding: adapter-pg 7.9 replaces offsets without converting
  wall-clock values. Bind instant filters/cursors as `date.toISOString()`
  strings cast to `::timestamptz`; Prisma `Date` parameters can lose the
  offset before PostgreSQL applies the session zone. Keep ordering and
  comparisons on the original instant columns; see `queueInspection.ts` and
  the summer/winter regression in `adminInsight.spec.ts`.
- `DiagnosticEvent.createdAt` follows that rule at the process boundary and
  has no database default. The original diagnostics migration is immutable;
  `20260910090100_diagnostics_event_created_at_utc` removes its default.
- Enums only for closed vocabularies owned by Prisma (`Role`); Better Auth-owned role strings (`Member.role`, `Invitation.role`) stay free-text String because the plugin writes them directly.
- Constraints Prisma can't express (partial uniques, CHECKs, backfills) go in hand-authored migration SQL plus a schema comment.
- `Verification_dpop_replay_expiry_idx` is an intentional partial index for
  expired `dpop-proof:` replay cleanup; do not broaden cleanup to live or
  non-DPoP Better Auth verification rows.
- Seeds are idempotent upserts by natural key (`packages/core/scripts/seed.ts`): `admin@weaver.local` (global Admin), `owner@`/`maintainer@`/`editor@`/`viewer@weaver.local`, password `admin1234567` for all, plus the Demo Project with one membership per project role. Users are created through `@weaver/auth`'s `createCredentialUser`, and the core-owned seed uses `createProject` plus metadata sync and needs `AUTH_SECRET`. The e2e DB can be seeded for manual exploration via `pnpm db:e2e:seed` (same script against `.env.e2e`); the suite itself wipes and re-creates login users in global-setup. Demo
  Project memberships are upserted on every run; a soft-deleted Demo Project
  stays deleted and a fresh one is created.
- `resetDb()` TRUNCATEs every table including `OauthResource`, but the OAuth provider only seeds that row once at plugin init — specs that authorize against it call `ensureOAuthResource()` (`apps/web/tests/integration/_harness.ts`) to re-create it after a reset.
- `resetDb()` also calls `invalidateLlmRouteCache()` before truncation so a
  prior spec's 15-second route snapshot cannot cross test boundaries.
- Drift check without a shadow database: from `packages/db`,
  `pnpm exec dotenv -e ../../.env -- prisma migrate diff --from-config-datasource --to-schema ./prisma/schema.prisma --script --config ./prisma.config.ts`.
  The only expected output is the Prisma-unsupported `searchVector`
  (tsvector) and `embedding` (vector) columns; anything else is drift.

## How to: add a schema change + migration

1. Edit `packages/db/prisma/schema.prisma` per the conventions above.
2. Hand-author `packages/db/prisma/migrations/<UTC-timestamp>_<slug>/migration.sql`; the timestamp must sort after every existing folder. Never use `prisma migrate dev`.
3. Write DDL in Prisma's style; append raw SQL Prisma can't express, with a comment why.
4. Apply immediately: `pnpm db:migrate` (dev DB), then `pnpm db:test:migrate` / `pnpm db:e2e:migrate` before running those suites (CLAUDE.md Standing Rule #3). These commands route through `packages/db/prisma/migrate-deploy.ts`; never bypass it with bare Prisma when the OAuth generation cutover could be pending. That wrapper enforces a quiesced database and an `OauthConsent` `EXCLUSIVE` first-lock barrier before handing the cutover to Prisma.
5. `pnpm db:generate`; verify with
   `node scripts/require-env.mjs .env weaver ./data -- pnpm --filter @weaver/db exec prisma migrate status --config prisma.config.ts` from the repository root.
6. If the change affects reads/access, wire it through
   `packages/core/src/services/`; update docs/IMPLEMENTATION.md (Standing Rule
   #1).

## Common mistakes

| Mistake                                              | Reality/Fix                                                                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Running `prisma migrate dev`                         | Unreliable locally by convention; hand-author SQL + `pnpm db:migrate` (deploy)                                                                                                              |
| Bare `new PrismaClient()` in a script                | Won't connect; pass the `PrismaPg` adapter                                                                                                                                                  |
| `findUnique` on `Project` by id                      | Returns soft-deleted rows; `findFirst` + `...notDeleted` (or `resolveProjectAccess`)                                                                                                        |
| `Promise.all` on `tx`                                | One pg connection per tx; sequential awaits only                                                                                                                                            |
| Matching P2002/unique errors by ad-hoc string checks | Weaver maps conflicts explicitly in services (e.g. "Already a member" → CONFLICT in `projectMembers.ts`); keep checks explicit                                                              |
| Type errors after schema edit                        | Stale generated client; `pnpm db:generate`                                                                                                                                                  |
| Running destructive Prisma actions unprompted        | Needs `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=1` + explicit user consent; wipe/reseed is manual drop/recreate + `pnpm db:migrate && pnpm db:seed` (there is no `pnpm db:reset` script) |
| Editing an applied migration                         | Append-only; write a new migration instead                                                                                                                                                  |
| `CURRENT_TIMESTAMP`/`now()` in raw SQL               | Stores the session time zone's wall-clock beside Prisma's UTC values; use `UTC_NOW` and set `createdAt` explicitly                                                                          |
| Running bare `prisma migrate deploy`                 | Bypasses the OAuth cutover quiescence/lock-order barrier; use the root `db:*:migrate` commands or `@weaver/db migrate:deploy`                                                               |
| Adding `url` to the datasource block                 | The CLI reads `packages/db/prisma.config.ts`; the block stays url-less                                                                                                                      |
| Pointing a suite at the wrong DB                     | `scripts/require-env.mjs` wraps `db:*`/test/e2e scripts and aborts on a missing file, a wrong database/data-dir pair, or a differing shell `DATABASE_URL`; fix the file, never bypass it    |
| Adding an FK from `DocumentLink.targetDocumentId`    | Breaks unresolved/deleted-target recovery; preserve the no-FK projection and enforce project scope in queries                                                                               |

## See also

`20261018090000_oidc_account_issuer_guard` adds the Account OIDC identity trigger.
OIDC issuer inserts/updates acquire `weaver:oidc-settings` and recheck the saved
issuer, serializing first account creation with `oidcSettings.ts` replacement.
Keep this guard even though Prisma cannot express it; credential accounts and
ordinary token updates do not acquire this lock.

weaver-trpc-routers (service/router layering), weaver-testing (harness, three-DB cadence), weaver-auth (session vs per-project roles). CLAUDE.md Standing Rules #3–#4; docs/IMPLEMENTATION.md.

- Project membership writes share one transaction lock. Non-Owner actors may change or remove only strictly lower-ranked members. Project creation budgets Git I/O explicitly and cleans only fresh repositories whose database rollback is confirmed.

## Background-work read model

BackgroundWorkReceipt (Phase 6B) stores user/kind/workId/revision as its composite key with cascading User deletion and a seenAt index. There is no FK to heterogeneous source work. The backgroundWork service inserts exact visible personal completion revisions with UTC_NOW; system.reconcile prunes up to 5,000 receipts older than 14 days. Read-index migrations 20260919000100/20260919000200 support source ownership and completion lookup. See weaver-jobs.

## Content appearance projections

Migration `20261008120000_content_appearance` adds nullable `appearance Json?`
to `Document` and `DataTable`. Git metadata is authoritative: the optional
appearance lives in document comment headers, folder metadata and table schemas
(`packages/core/src/appearance/metadata.ts`). No folder model or backfill is
needed; legacy files and existing rows keep absent appearance. Shared document
metadata columns and every table projection writer/rebuild derive it from Git;
clear absent values with `Prisma.DbNull`, and normalize projection JSON in
item list/tree responses.

## Document review models

Migration `20261007090000_document_review`. `ReviewerGroup` (unique
`(projectId, name)`, cascades with the project), `ReviewerGroupMember`
(composite key `(groupId, userId)`, cascades with group and user),
`ProjectDefaultReviewer` (`userId` xor `groupId`, unique per project and target;
the `ProjectDefaultReviewer_one_target` CHECK exists only in the migration SQL,
not in `schema.prisma`) and `DocumentReviewer` (projection of the header
`reviewers`: `type`, `refId`, `name`; `userId`/`groupId` link only while the
target is a current member / existing group, set null on delete). `Project`
gains `defaultReviewEveryMonths` (default 12) and `documentHeaderVersion` now
defaults to 3 (existing projects stay at 2 until the upgrade pass). `Document`
gains nullable `reviewEveryMonths`/`reviewSince`/`lastReviewedAt`/`reviewedById`/
`reviewedByName`/`reviewDueAt` (indexes on `reviewDueAt` and, from migration `20261007090100_document_review_due_index`, `(projectId, reviewDueAt, id)` for the due queries; migration `20261008100000_document_last_reviewed_index` adds `lastReviewedAt` and `(projectId, lastReviewedAt, id)` for the recently reviewed list); null means the file has
no review block yet. The migration seeds every current Owner as default reviewer.
Group and default-reviewer writes run under the project membership lock, and
every membership removal clears their groups, defaults and `DocumentReviewer.userId` and every membership creation re-links it (`services/projectReviewerLinks.ts`, in the membership transaction).
All of it is rebuildable from Git except groups and defaults (database is the
source; `project.json` mirrors them).

Migration `20261008110000_review_due_future_clamp` repairs future
`reviewDueAt` values left by the never-reviewed backfill. It clamps to the
earlier of `reviewSince` and UTC now only when a never-reviewed document's
due date is still in the future; already-due rows and reviewed documents stay
unchanged. Keep applied migrations immutable and add corrective migrations.

## Project pins

`ProjectContentPin` stores project/kind/resource UUIDs independently of Document
and DataTable projections: table rebuild deletes and recreates projection rows.
Project hard deletion cascades pins; creator deletion sets createdById null.
Missing targets remain stored and count toward the 12-pin limit; resolve them
only through project + kind + resource ID. `services/dashboard/pins.ts` serializes
new pin capacity on the Project row and rechecks Maintainer/content:write access.

The Prisma pool pins its PostgreSQL session timezone to UTC. Review migrations
20260921000900/20260921001000 add missing FK indexes, align external connection
createdAt defaults and create UploadRateLimit (per-user/channel fixed minute
windows, cascading with User deletion). Preserve applied historical migrations;
new fixes use forward migrations. Reset guards also restrict test DB hosts to
loopback or the Compose postgres hostname.

`ApiKeyProject.project` restricts hard project deletion until affected key grants
are explicitly removed; cascading the final grant would widen a key.
`LlmModel.contextWindow` and `maxOutputTokens` are positive or null by CHECK;
20260922220200 normalizes legacy zero values to null before adding those guards.

## Wiki queue

`WikiInputItem` and `WikiRun` (`20261103110000_wiki_input_and_run`; `PersonalWorkKind.wiki` and `IngestionOrigin.wiki` are separate `ALTER TYPE` migrations).
`WikiRun_active_project_key` is a partial unique index on `projectId` for `preparing`, `queued`, `running`. `Document` and `DataTable.wikiSourceItemId`
have a `DEFERRABLE INITIALLY DEFERRED` no-action FK (`20261103110300`): a linked item cannot be deleted while a page still references it at commit, and a hard
project delete works in any cascade order, which a dump and restore can change. `wikiSources.spec.ts` pins both. User references on the item and run are `SET NULL`. `sourceDocumentId` and `sourceTableId` are plain uuids.

## Project machine credentials

ProjectApiKey and ProjectApiKeyGrant are project-owned authority state, separate
from Better Auth personal keys. Creator deletion sets createdById null. Grant
targets deliberately have no Document/DataTable projection FK; root grants use
an explicit marker and partial unique index. ProjectApiOperation reservations,
ProjectApiAuditEvent metadata, and ProjectApiRateWindow counters cascade with
the key/project. Composite key/project FKs prevent foreign operation/audit rows.
Receipt state CHECKs require a non-null committed SHA for success; the forward
20261013120100 migration preserves unknown-SHA receipts as reservations.
Document/DataTable lastEditedByMachineKind/lastEditedByMachineId (CHECK: both or
neither, one editor kind; expand only), lastEditedByProjectKeyId (dual-written, no
reader; a later release drops it) and lastEditedByName are nullable Git-derived
attribution, never User references. WikiAgent has a partial unique index on
projectId WHERE revokedAt IS NULL. Apply both 20261013120000 and
20261013120100 through the guarded migration commands before machine APIs run.
Key-policy writes run inside withProjectRepo, then a transaction that takes
lockProjectMembershipWrites and rechecks the role; never take the database lock
first. That transaction may commit a legacy folder identity, so it uses an
explicit 60 s timeout. softDeleteProject and personal-workspace orphan cleanup
hold the project lock before changing liveness or removing the repository.

## Exams

Exam definitions, snapshots, answers and operation receipts live only in PostgreSQL. `ExamAttempt_open_attempt_key` enforces one in-progress attempt per exam/trainee. See `weaver-exams` for locking and snapshot invariants.

## Review hardening invariants

Wrap dependent migration DDL/DML in BEGIN/COMMIT unless a specific operation forbids transactions. Never edit released migration history. The guarded, idempotent knowledge-index-identity recovery SQL and docs/setup.md runbook handle its historical partial-failure case; the forward correction reruns verified fingerprints and releases affected processing claims.
