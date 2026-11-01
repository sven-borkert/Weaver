---
name: weaver-projects
description: Use when changing Weaver project creation/deletion, personal workspaces, landing-project selection, project membership, or project.json synchronization. Authentication primitives are covered by weaver-auth.
---

# Weaver projects and personal workspaces

Project lifecycle spans database authority, Better Auth organizations, Git
metadata, and the user's landing route. Change those boundaries together.

## Entry points

| Path                                                 | Responsibility                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/core/src/services/projects.ts`             | Project create/update/soft delete and initial repository ownership        |
| `packages/core/src/services/personalWorkspace.ts`    | Ensure one personal workspace; repair membership and clean up race losers |
| `packages/core/src/services/landingProject.ts`       | Record last-opened project and choose the landing destination             |
| `packages/core/src/services/projectMembers.ts`       | Membership writes, project-row locking, grantable ranks, last-Owner guard |
| `packages/core/src/services/projectMetadata.ts`      | Synchronize root `project.json` from database truth                       |
| `packages/core/src/services/projectReviewerLinks.ts` | Keep membership-linked reviewer state coherent                            |
| `apps/web/src/server/api/routers/project.ts`         | Project procedure adapter                                                 |
| `apps/web/src/server/api/routers/projectMember.ts`   | Membership procedure adapter                                              |
| `apps/web/src/server/api/routers/account.ts`         | Landing-project and personal-account procedures                           |

Read `weaver-auth` for actor/membership policy, `weaver-git-store` for repository
primitives, and `weaver-database` when changing schema or migrations.

## Lifecycle invariants

- Create the organization, project, Owner membership, default reviewer, and
  initial Git metadata through the existing creation transaction. Git failure
  must roll back database rows. Remove a newly created repository only after a
  follow-up read confirms rollback; uncertain commit acknowledgement is not
  evidence that its storage can be deleted.
- Project reads use `notDeleted` and membership checks. Global Admin is not a
  content superuser. Soft deletion rechecks Owner access under the repository
  lock and pauses active scheduled tasks with `nextRunAt: null`. Administrative
  project views currently inspect live projects; they do not implement a
  restoration or purge workflow.
- `personalOwnerId` uniqueness also covers soft-deleted rows. Clear a deleted
  holder's ownership before claiming a replacement. The advisory transaction
  ends before `createProject`; the later unique ownership claim chooses the
  winner. Its P2002 path returns the winner and cleans up only its own fresh
  project, organization, and repository under the project lock.
- `ensurePersonalWorkspace` also repairs a missing Owner membership, reviewer
  links, and `project.json`. Personal workspaces cannot be deleted, and their
  personal Owner cannot be demoted or removed.
- Landing selection is: the stored live joined project, otherwise the most
  recently updated live joined project, otherwise ensure the personal workspace.
  Recording last-opened requires Viewer access. Membership removal or soft
  deletion must not leave an accessible-looking stale landing destination.
- Membership changes serialize through `lockProjectMembershipWrites`, preserve
  the last Owner, and enforce grantable rank. The separately guarded global
  Admin recovery path lives in user administration; do not copy its bypass into
  normal project-member mutations.
- `project.json` is a Git representation of current database metadata. Preserve
  history and reviewer settings when synchronizing it. Domain operations must
  continue to ignore this root metadata file as user content.

## Changing the flow

Follow changes through the core service, tRPC adapter, project settings or
switcher, and cache invalidation. The browser must invalidate
`account.landingProject` after project/membership changes; see `weaver-ui-pages`
and `weaver-forms-dialogs` for UI behavior. Use `weaver-jobs` if deletion or
metadata writes affect scheduled work or Git synchronization.

## Verification

Use `weaver-testing` and its guarded test database. Select the affected specs:

```sh
pnpm test:integration apps/web/tests/integration/projects.spec.ts apps/web/tests/integration/personalWorkspace.spec.ts apps/web/tests/integration/landingProject.spec.ts apps/web/tests/integration/projectMembers.spec.ts
```

Use `apps/web/tests/integration/users.spec.ts` when touching administrative
membership recovery. Colocated lifecycle utility tests are in
`packages/core/src/services/projects.test.ts` and
`packages/core/src/services/personalWorkspace.test.ts`. For race fixes, retain
both the winning identity and cleanup assertions; a successful returned ID alone
does not prove that a duplicate repository or organization was removed.

## Exams

Membership removal also calls `unlinkUserFromProjectTraining` in the membership transaction, including admin removal. `project.json` member entries optionally mirror `training: trainer | trainee`.
