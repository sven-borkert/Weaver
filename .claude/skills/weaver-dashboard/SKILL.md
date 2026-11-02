---
name: weaver-dashboard
description: Use when changing Weaver dashboard read models, recent content, project overview/activity, shared pins, report shortcuts, audience selection, counts or activity pagination. Background-job execution is covered by weaver-jobs.
---

Wiki runs are activity source `wiki` (`ACTIVITY_SOURCES`) through the shared work relation; the destination is `/projects/<id>/wiki`.

# Weaver dashboard and project activity

Dashboard responses combine authorized content and work into bounded read models.
A UI filter must not silently widen the audience or task ownership.

## Entry points

| Path                                                                                      | Responsibility                                       |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `packages/core/src/services/dashboard.ts`                                                 | Public service exports                               |
| `packages/core/src/services/dashboard/access.ts`                                          | Session/content gate and project-specific audience   |
| `packages/core/src/services/dashboard/content.ts`                                         | Bounded recent document/table reads                  |
| `packages/core/src/services/dashboard/project.ts`                                         | Overview, capped counts, pin projection and capacity |
| `packages/core/src/services/dashboard/pins.ts`                                            | Transactional pin admission/removal                  |
| `packages/core/src/services/dashboard/activity.ts`                                        | Content/work activity composition                    |
| `packages/core/src/services/dashboard/reportShortcuts.ts`                                 | Caller-owned report task shortcuts                   |
| `packages/core/src/services/dashboard/cursor.ts`                                          | Signed actor/filter/window-bound cursors             |
| `packages/core/src/dashboard/schema.ts`                                                   | Browser-safe inputs, destinations and DTOs           |
| `apps/web/src/server/api/routers/dashboard.ts`                                            | tRPC adapter                                         |
| `apps/web/src/components/dashboard/`                                                      | Shared cards, lists, pins and report presentation    |
| `apps/web/src/app/(workspace)/projects/[projectId]/_components/ProjectActivityScreen.tsx` | Project Activity page composition                    |

Read `weaver-auth` for membership/capability policy, `weaver-jobs` for source rows
and work audiences, and `weaver-ui-pages` for shell, polling and cache behavior.

## Read and mutation boundaries

- Dashboard reads require a session and content access. A project filter alone
  does not request shared work. Home activity defaults to `mine`; use an
  explicitly authorized `projects` audience or the overview's returned
  `workAudience` for shared work.
- Project overview chooses the audience from live project access and returns
  `canManagePins` and `pinCapacity`. The browser uses those fields rather than
  inferring permission from a global role or a cached membership.
- Pin creation locks the Project row and rechecks Maintainer plus `content:write`.
  Removal rechecks authorization transactionally without that row lock.
  Validate project, resource kind and ID together. Duplicate pins are idempotent;
  unavailable pins still count toward the 12-slot capacity. Read-only viewers
  must not receive curator-only unavailable placeholders or capacity data.
- Recent-content SQL bounds each project's document/table candidates with
  `LATERAL` subqueries before the global ordering. Preserve per-project and
  response limits rather than materializing every visible content row.
- Overview document/table counts cap at 10,000 and report `capped`. Preserve
  that qualifier in DTOs/UI; the capped value is not an exact total.
- Report shortcuts always select the caller's own scheduled tasks, including
  with a project filter. The current five-item ordering is
  `lastRunAt DESC NULLS LAST, createdAt DESC, id DESC`. Task `status`
  (`active | paused`) is distinct from `lastRunStatus`. Resolve a current report
  only inside the task's output project. Preserve ownership and null ordering
  when adding pagination or filters.
- Activity cursors bind actor, audience/project/view, snapshot time and exact
  content/work window lengths with HMAC. Reuse the cursor helpers; a raw offset
  or filter-agnostic token can mix audiences or skip rows when sources change.
  Activity's cursor helpers are specific to its audience/project/view and sort
  tuple. New report pagination needs its own contract binding caller, project,
  status filter and report ordering; do not reuse an activity payload unchanged.
  Read `DASHBOARD_LIMITS` in the schema for canonical limits.
- Permission failures clear stale cached content. Transient refresh failures
  may keep a labeled prior snapshot; they must not masquerade as empty results.

## Verification

Use `weaver-testing` and the guarded test database:

```sh
pnpm test:integration apps/web/tests/integration/dashboard.spec.ts apps/web/tests/integration/projectPins.spec.ts
```

Cursor/row utility tests live alongside the dashboard services. UI tests use the
web unit runner; `apps/web/tests/e2e/dashboard.spec.ts` is browser coverage and
requires the normal Tier 3 consent. Query changes should cover ownership under
project filters, nonmembers/Admins without membership, read-only maintainers,
unavailable pin capacity and pagination after data changes.

Raw readers select the machine editor pair (`lastEditedByMachineKind`/`Id`), not the old
project key column; Activity's "Changes by others" counts any machine editor.
