# CLAUDE.md / AGENTS.md — Weaver

Project instructions for AI coding agents. Claude Code loads this file as
`CLAUDE.md`; Codex loads it as `AGENTS.md` (a symlink to this file). Read
once at the start of every session.

## What this is

Weaver is a multi-project knowledge & documentation platform: projects hold
rich-text documents, spreadsheet-like tables, and an auto-maintained knowledge
graph, with an AI assistant and background AI jobs on top. Architecture: `docs/IMPLEMENTATION.md`. Phase status: `docs/IMPLEMENTATION.md`
§Implementation status.

## ⚠️ Three databases — never mix them up

| Database      | Git data dir  | Purpose                                | Env file    | pnpm command driving it                               |
| ------------- | ------------- | -------------------------------------- | ----------- | ----------------------------------------------------- |
| `weaver`      | `./data`      | Local dev (manual exploration, seeded) | `.env`      | `pnpm dev`, `pnpm db:seed`                            |
| `weaver_test` | `./data-test` | Vitest integration suite               | `.env.test` | `pnpm test:integration`                               |
| `weaver_e2e`  | `./data-e2e`  | Playwright end-to-end suite            | `.env.e2e`  | `pnpm e2e`, `pnpm db:e2e:migrate`, `pnpm db:e2e:seed` |

**Hard rule:** test suites must point at `weaver_test` + `./data-test` or
`weaver_e2e` + `./data-e2e`. Integration and e2e resets TRUNCATE every table
and recursively remove `${WEAVER_DATA_DIR}/git`. The root `db:*`,
`test:integration*`, and `e2e` scripts run through
`scripts/require-env.mjs`, which refuses to start when the env file is
missing, when its `DATABASE_URL`/`WEAVER_DATA_DIR` name a different pair than
the table above, or when a shell `DATABASE_URL`/`WEAVER_DATA_DIR` differs from
the file. Fix the file (or unset the shell variable) instead of bypassing the
guard; dev values would delete both dev database rows and dev Git
repositories.

## Standing rules

### 1. Maintain the implementation documentation

The architecture / how-it-fits-together reference lives at
`docs/IMPLEMENTATION.md`. When you ship a feature that adds, renames, or
restructures a router, service, schema, migration, or UI area — update the
relevant section in the same commit. Keep it a navigation aid: short, linking
canonical files.

### 2. Maintain the changelog

User-visible changes go into `docs/CHANGELOG.md` (Keep a Changelog format) in
the same commit. Internal-only refactors and doc tweaks need no entry.

Close the `[Unreleased]` section into a version heading (`## [x.y.z] - date`,
using the current `package.json` version) at every phase or slice boundary,
and whenever the user asks for a release. Patch bumps between headings are
expected; never leave more than one phase under `[Unreleased]`.

### 3. Apply required database migrations immediately

When code introduces or pulls a migration the app depends on, apply it to the
dev database before continuing (`pnpm db:migrate`). Apply `.env.test` /
`.env.e2e` migrations (`pnpm db:test:migrate` / `pnpm db:e2e:migrate`) before
running the corresponding suites. Migrations are hand-authored SQL; never use
`prisma migrate dev`.

### 4. Follow the tiered testing cadence

**Tier 1 — run freely:** `pnpm lint`, `pnpm typecheck`, `pnpm format:check`,
`pnpm check`, `pnpm test` (unit + script checks), a single integration spec
(`pnpm test:integration apps/web/tests/integration/<file>.spec.ts`).

**Tier 2 — area sets** (when a change spans several specs of one area): run
the related specs together.

**Tier 3 — ask first:** full `pnpm test:integration` and any `pnpm e2e`
(it rebuilds the app). Ask the user; after agreement prefix with
`RUN_FULL_TESTS=1`. Hooks in `.claude/settings.json` / `.codex/hooks.json`
enforce this via `scripts/guard-expensive-tests.mjs`.

| Source you changed                                                | Run this                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------- |
| `apps/web/src/server/api/routers/<area>.ts`                       | `apps/web/tests/integration/<area>.spec.ts`             |
| `packages/core/src/services/<name>.ts`                            | affected `apps/web/tests/integration/<name(s)>.spec.ts` |
| app/package pure utility                                          | colocated `*.test.ts` via `pnpm test`                   |
| `packages/db/prisma/schema.prisma`, migrations, or shared runtime | the affected area specs (Tier 2)                        |
| Documents server foundation                                       | `pnpm test:integration:documents` (Tier 2)              |
| UI only (`apps/web/src/app/**`, `apps/web/src/components/**`)     | `pnpm check`; browser coverage is Tier 3                |

### 5. Bump the application version before pushing

The version lives in `package.json` and is displayed by `/api/health`.
Increase the patch number by 1 before every push to `origin` unless the user
asks for a different bump.

Completed feature work must be merged into `main` and pushed to `origin/main`.
Do not leave completed work only on a feature branch. After verifying that
`origin/main` contains all branch commits, delete the local and remote feature
branches and remove agent-created worktrees, preserving unique local files.
Check for other unmerged feature branches when finishing work; integrate and
verify their outstanding work before deleting them. This is the user's standing
preference; no additional merge or branch-cleanup confirmation is needed.

### 6. Consult and maintain the project skills

Area conventions live as skills under `.claude/skills/<name>/SKILL.md`
(canonical copies; `.codex/skills/` contains symlinks so Codex finds them).
**Before working in one of these areas, read the matching skill** — if your
harness has not auto-loaded it, open the file directly:

| Skill                     | Area                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `weaver-exams`            | Training roles, exam definitions, timed attempts, reviewed grades, notifications and exam agent tools                    |
| `weaver-database`         | Prisma schema, migrations, soft delete, seeds, three-DB rules                                                            |
| `weaver-trpc-routers`     | tRPC procedures, access checks, error mapping                                                                            |
| `weaver-testing`          | Test harness mechanics, spec recipes, tiered cadence                                                                     |
| `weaver-ui-pages`         | Route groups, layouts, navigation, shared explorer/appearance, unsaved-change guards, design-token styling               |
| `weaver-forms-dialogs`    | Create/edit forms, dialogs, delete confirmations, mutation UX                                                            |
| `weaver-entity-tables`    | List views, tables, filtering, sorting, pagination                                                                       |
| `weaver-auth`             | Better Auth (`@weaver/auth`), sessions/sign-in-out, `SecurityContext`/capabilities, global vs organization/project roles |
| `weaver-oidc`             | External OIDC login, Authentik setup, discovery/callbacks, verified-email linking, first-login provisioning              |
| `weaver-projects`         | Project creation/deletion, personal workspaces, landing selection, membership and project.json synchronization           |
| `weaver-project-api`      | Project-owned machine keys/grants, /api/v1/projects contracts, publishing, revision/idempotency guards and recovery      |
| `weaver-git-store`        | Shared Git readers/writers, advisory locks, snapshots, recovery, attribution and SSH transport primitives                |
| `weaver-dashboard`        | Dashboard/recent-content read models, project overview/activity, pins, report shortcuts and audience-bound pagination    |
| `weaver-remote-instances` | Peer registry, per-user OAuth callback/refresh/disconnect and document/table send/receive                                |
| `weaver-env-deploy`       | env vars, three DBs, docker-compose, base path, health                                                                   |
| `weaver-documents`        | Git-backed documents, raw/rich editor, review/reviewer groups, references, history, Git push/pull                        |
| `weaver-tables`           | Git-backed typed tables, folders, grid editor                                                                            |
| `weaver-knowledge-graph`  | Knowledge indexing, entities, relations, search, graph APIs/UI                                                           |
| `weaver-assistant`        | Assistant runs, proposals, citations, tool contracts, inbound MCP and personal external MCP review/approval/dispatch     |
| `weaver-ingestion`        | Uploads, native/Docling/OCR parsing, durable ingestion stages/drafts, reviewed acceptance and external feeds             |
| `weaver-jobs`             | Publisher/worker ownership, pg-boss claims/recovery, work visibility/receipts and durable Git push/pull jobs             |
| `weaver-admin`            | Admin area, LLM providers/models/routing, outbound MCP transport/catalog, diagnostics and operational tools              |
| `weaver-diagnostics`      | Diagnostic log, level/retention, runtime hooks, and admin MCP tools                                                      |
| `weaver-scheduled-tasks`  | Scheduled AI tasks: model, tick, runner, run history, Tasks UI                                                           |
| `weaver-wiki`             | Wiki-agent foundations: page properties, wiki reads, MCP `wiki` toolset, change kinds, tracked-link teaching             |
| `weaver-artifacts`        | Artifact storage/routes, Word/Excel/PDF/JSON/text/Markdown/CSV/YAML readers and OneNote cache/preparation                |

When a convention a skill documents changes, update the skill in the same
commit. A new skill gets a directory under `.claude/skills/` plus a matching
`.codex/skills/<name>` symlink (`ln -s ../../.claude/skills/<name>`); never
copy skills elsewhere.

## Local setup

Full walkthrough: `docs/setup.md`. Short version:

1. Node 22+, pnpm 12 (corepack 0.34+; `corepack enable && corepack prepare pnpm@12.14.0 --activate`), Docker (or local PostgreSQL 17).
2. `cp .env.example .env` — fill the DB password placeholder, generate `AUTH_SECRET` (`openssl rand -base64 32`). Create `.env.test`/`.env.e2e` as copies pointing at `weaver_test`/`weaver_e2e` with their own `AUTH_SECRET`s.
3. Database provisioning: with a host PostgreSQL run `./scripts/provision-databases.sh`; without a local Postgres run `./start-database.sh` first — note the container only creates the `weaver` DB, so create `weaver_test`/`weaver_e2e` inside it per docs/setup.md.
4. `pnpm install` (runs `prisma generate` via postinstall).
5. `pnpm db:migrate && pnpm db:test:migrate && pnpm db:e2e:migrate`
6. `pnpm db:seed` — creates `admin@weaver.local` + demo users (password `admin1234567`) and the Demo Project.
7. `pnpm dev` → http://localhost:3000.
8. One-time for e2e: `pnpm exec playwright install chromium`.

To wipe and re-seed the dev DB: `prisma migrate reset` equivalent is manual —
drop/recreate the `weaver` DB, re-run `pnpm db:migrate && pnpm db:seed`.
Prisma destructive actions require explicit user consent each time
(`PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=1`).

## Repository specifics

- Stack: Next.js 16 App Router + React 19 + tRPC 11 + Prisma 7 + PostgreSQL;
  pnpm. Prisma 7 requires the `@prisma/adapter-pg` driver adapter; the
  CLI connection URL lives in `packages/db/prisma.config.ts`; the runtime
  singleton/factory lives in `packages/db/src/`. Consumers import `db` from
  `@weaver/db` and generated Prisma types/client APIs from `@weaver/db/client`;
  only `packages/db` imports its generated client relatively. The datasource
  block has no `url` line.
- Auth: Better Auth email/password with database sessions (`packages/auth`,
  mounted in `apps/web/src/server/auth/index.ts`). Every request becomes a
  `SecurityContext` (`packages/core/src/security/context.ts`); per-project
  roles (`Owner | Maintainer | Editor | Viewer`) live on Better Auth
  organization members and are resolved per request in
  `packages/core/src/services/projectAccess.ts`. Global Admin (`Admin | User`)
  is not a content superuser — project access always requires membership.
- Soft delete: `Project.deletedAt` + `notDeleted` spread on reads.
- UI: Tailwind v4 design tokens in `apps/web/src/styles/globals.css`;
  shadcn-style primitives in `apps/web/src/components/ui/`.

## Conventions

- Don't write multi-paragraph code comments. One short line max, only when the
  WHY is non-obvious.
- Don't create planning, decision, or analysis files unless the user asks.
- Don't bypass safety: never `--no-verify`, never `--force` without explicit
  user instruction, never amend pushed commits.
- Test cadence follows Standing Rule #4 — default to a single spec while
  iterating; run long commands once and filter their output file instead of
  re-running.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `apps/web/node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
