---
name: weaver-exams
description: Use when changing Weaver training roles, exam definitions, timed attempts, grade proposals and release, exam notifications, or exam MCP and assistant tools.
---

# Weaver exams

Exams live in PostgreSQL; never add them to Git content, indexing, search,
exports or transfers. `project.json` mirrors training roles only.

| File                                                       | Responsibility                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/db/prisma/schema.prisma`                         | Training role, definitions, attempt snapshots, answers, operation receipts |
| `packages/core/src/exams/schema.ts`                        | Browser-safe validation, trainee projections and scoring                   |
| `packages/core/src/services/projectTraining.ts`            | Orthogonal role gates, membership-locked assignment and cleanup            |
| `packages/core/src/services/exams.ts`                      | Definition lifecycle and snapshots                                         |
| `packages/core/src/services/examAttempts.ts`               | Timed attempts, answer saves, grades and release                           |
| `packages/core/src/exams/tick.ts`                          | Expiry sweep under tasks worker role                                       |
| `packages/core/src/services/backgroundWork/examSource.ts`  | Current-trainee-only personal bell source                                  |
| `packages/core/src/services/examOperations.ts`             | Idempotent agent write receipts                                            |
| `apps/web/src/server/api/routers/exam.ts`                  | Thin browser adapter                                                       |
| `apps/web/src/app/(workspace)/projects/[projectId]/exams/` | Lists, editor, taking and review screens                                   |
| `packages/assistant-tools/src/tools/exams/`                | Seven scoped trainer tools                                                 |

Training Off hides exam navigation and routes, including bell results. Content
rank grants no implicit training powers. Membership, credential capability and
current training role are checked in core. Task and project-machine principals
cannot use exams. Trainee procedures require sessions. Grade release requires a
session trainer and refuses assistant-marked calls.

Attempts snapshot the full definition at start, with each question's choices
shuffled once (`shuffleChoices`); match choices by ID, never by position.
`autoScoreFor` awards weight × (right − wrong) / correct choices, floored at 0
and rounded to cents. Use `traineeQuestionViews` to
exclude correct choices, guidance and grades until release. Serialize all saves,
submission and grading under the attempt row lock; recheck status after locking.
Client sequence ordering prevents delayed answer writes from rolling back newer
answers. Reorder live questions through temporary positions to avoid unique-index
collisions. Coordinate exam snapshots and lifecycle changes with the exam lock.

Mount the nested choices field array only for multiple-choice questions; free-text
validation rejects any choices array. Remount it when the question index changes
so reordering keeps the hook bound to the current field path.

The server clock owns the deadline, with ten seconds of save grace. `exam.tick`
finalizes abandoned attempts every minute. Flush all unacknowledged edits before
manual or expiry submission; failed/retrying edits remain unsaved and must block
submission until flushed or the attempt closes. Never claim a submission succeeded
before the server acknowledges it.

`exam.deleteAttempt` is session-only: trainers delete project attempts and trainees
only their own, in any status. Lock the exam before the attempt, matching start and
definition deletion; answers cascade. Starting uses the maximum remaining attempt
number plus one so deleting an earlier attempt cannot create duplicate numbers.
`DeleteAttemptButton` confirms deletion in results and ongoing trainee cards;
refresh exam lists/details and the background-work bell afterward. Trainer Results
also exposes ongoing attempts. Editor `ExamTextarea` grows with content and width
changes so long prompts do not create nested vertical scrolling.

On every attempt-page visit, fetch the current attempt before initializing the
answer form; cached answers can predate autosaves. Keep the initialized form
mounted during later refreshes and transient errors so local edits survive.

Keep completed attempts on `exams/results`, with role-specific tables and explicit
Open/Review actions, separate from exam creation and starting attempts. Trainer
results preserve cursor pagination and reset it on status changes. Render question
prompts through `ExamQuestionPrompt`, including code-example dialogs outside
disabled answer/grading controls. Questions must be self-contained: referenced
code goes in fenced Markdown blocks in `prompt`, never only in `expectedAnswer`.

Grades are proposals (`in_review`) until a trainer releases them. Free-text scores
require rationales. Preserve prior overrides when releasing without new grades.
Use revision guards for definitions and grading. A re-release changes the personal
notification revision; shared audiences never contain exam rows.

`EXAM_TOOLS` are separate from static `ASSISTANT_TOOLS` and MCP `core`. The
`exams` toolset exposes four reads and three writes; none accepts release.
Only trainers in effective assistant scope receive `ASSISTANT_EXAM_TOOLS` and
their schema bytes are charged to the actual context budget. Assistant runs never
write definitions directly: `propose_exam_create`/`propose_exam_update` store
`exam.create`/`exam.update` proposals (`services/examProposals.ts`, not part of
`contentOperationSchema`) that wait for Accept unless Auto-approve is on.
Proposal and acceptance check the trainer role, not Editor; acceptance claims,
writes and resolves in one transaction (resolution `{ revision }`, conflict when
the exam revision moved). Creation tools omit question/choice ids; update tools
keep a question only through its id from `get_exam`. Large tool reads must
continue every oversized field without silently omitting questions or guidance.
Recheck scope and current training authorization before idempotency replay.

Run `exams`, `examAttempts`, `examTools`, `projectMembers`, `users`,
`backgroundWork` and affected assistant/MCP integration specs through guarded
root commands, sequentially against `weaver_test`. Unit helpers and UI use
colocated tests and `pnpm check`. Browser `exams.spec.ts` and full integration
remain Tier 3 and require fresh consent.

## Review hardening invariants

Trainer listExams returns bounded {items,nextCursor} pages ordered by updatedAt DESC, id ASC. Aggregate attempt statuses (including expired in_progress) and question scores in SQL for only that page. loadExamDefinitionInTx supplies start snapshots without history counters. Attempt-list indexes cover project and project/exam startedAt DESC, id DESC ordering.
