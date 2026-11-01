import { randomUUID } from "node:crypto";
import type {
  Prisma,
  PrismaClient,
  ExamAttempt,
  ExamAttemptStatus,
  ExamSubmissionKind,
} from "@weaver/db/client";
import { CoreError } from "../errors";
import {
  examAnswerInputSchema,
  gradeAttemptInputSchema,
  examSnapshotSchema,
  traineeQuestionViews,
  autoScoreFor,
  autoRationaleFor,
  summarizeScores,
  remainingMs,
  shuffleChoices,
  type ExamAnswerInput,
  type ExamSnapshot,
  type TraineeQuestionView,
  type GradeAttemptInput,
} from "../exams/schema";
import { emitDiagnostic } from "../diagnostics/writer";
import {
  assertTrainer,
  assertTrainee,
  assertSessionPrincipal,
  trainerProjectIds,
  trainingRoleFor,
} from "./projectTraining";
import type { ProjectActor } from "./projectAccess";
import { resolveProjectAccess } from "./projectAccess";
import {
  effectiveAttempt,
  traineeSummary,
  snapshotOf,
  loadExamDefinitionInTx,
  type Db,
  type TraineeAttemptSummary,
} from "./exams";
import { encodePageCursor, decodeTimestampIdPageCursor } from "./adminPaging";
export const ATTEMPT_GRACE_MS = 10_000;
export type AttemptTiming = {
  startedAt: Date;
  deadlineAt: Date;
  serverNow: Date;
  remainingMs: number;
};
export type TraineeAttemptView = TraineeAttemptSummary & {
  examTitle: string;
  instructions: string;
  timing: AttemptTiming;
  questions: TraineeQuestionView[];
  overallFeedback: string | null;
  releasedByName: string | null;
};
export type SaveAnswerResult = {
  outcome: "saved" | "stale" | "expired" | "closed";
  sequence: number;
  savedAt: Date | null;
  timing: AttemptTiming;
};
export type AttemptListItem = {
  id: string;
  examId: string;
  examTitle: string;
  projectId: string;
  projectName: string;
  trainee: { id: string; name: string | null; email: string };
  attemptNumber: number;
  status: ExamAttemptStatus;
  startedAt: Date;
  deadlineAt: Date;
  submittedAt: Date | null;
  submissionKind: ExamSubmissionKind | null;
  gradedAt: Date | null;
  gradedByName: string | null;
  gradedVia: string | null;
  releasedAt: Date | null;
  releasedByName: string | null;
  totalScore: number | null;
  maxScore: number;
  percent: number | null;
  passed: boolean | null;
  revision: number;
};
export type ReviewAnswerView = {
  questionId: string;
  selectedChoiceIds: string[];
  text: string | null;
  savedAt: Date | null;
  autoScore: number | null;
  score: number | null;
  rationale: string | null;
};
export type ReviewAttemptView = AttemptListItem & {
  snapshot: ExamSnapshot;
  overallFeedback: string | null;
  answers: ReviewAnswerView[];
};
export type GradeAttemptCommand = GradeAttemptInput & {
  attemptId: string;
  expectedRevision: number;
  via?: "assistant";
};
function timing(row: ExamAttempt, now: Date): AttemptTiming {
  return {
    startedAt: row.startedAt,
    deadlineAt: row.deadlineAt,
    serverNow: now,
    remainingMs: remainingMs(row.deadlineAt, now),
  };
}
function expired(row: ExamAttempt, now: Date) {
  return (
    row.status === "in_progress" &&
    row.deadlineAt.getTime() + ATTEMPT_GRACE_MS < now.getTime()
  );
}
async function lockAttempt(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM "ExamAttempt" WHERE id = ${id}::uuid FOR UPDATE`;
  const row = await tx.examAttempt.findUnique({ where: { id } });
  if (!row) throw new CoreError("NOT_FOUND");
  return row;
}
async function own(db: Db, actor: ProjectActor, id: string, write = false) {
  const row = await db.examAttempt.findUnique({ where: { id } });
  if (row?.traineeId !== actor.userId) throw new CoreError("NOT_FOUND");
  await assertTrainee(db, row.projectId, actor, {
    capability: write ? "content:write" : "content:read",
  });
  return row;
}
async function ownView(
  db: Db,
  row: ExamAttempt,
  now: Date,
): Promise<TraineeAttemptView> {
  const snapshot = examSnapshotSchema.parse(row.definitionSnapshot);
  const answers = await db.examAnswer.findMany({
    where: { attemptId: row.id },
  });
  const released = row.status === "released";
  return {
    ...traineeSummary(row, now),
    examTitle: snapshot.title,
    instructions: snapshot.instructions,
    timing: timing(row, now),
    questions: traineeQuestionViews({
      snapshot,
      answers: new Map(answers.map((a) => [a.questionId, a])),
      released,
    }),
    overallFeedback: released ? row.overallFeedback : null,
    releasedByName: released ? row.releasedByName : null,
  };
}
export async function deleteAttempt(
  db: PrismaClient,
  actor: ProjectActor,
  attemptId: string,
): Promise<void> {
  assertSessionPrincipal(actor);
  await db.$transaction(async (tx) => {
    const initial = await tx.examAttempt.findUnique({
      where: { id: attemptId },
    });
    if (!initial) throw new CoreError("NOT_FOUND");
    await tx.$queryRaw`SELECT id FROM "Exam" WHERE id = ${initial.examId}::uuid FOR UPDATE`;
    const row = await lockAttempt(tx, attemptId);
    if ((await trainingRoleFor(tx, row.projectId, actor.userId)) === "trainer")
      await assertTrainer(tx, row.projectId, actor);
    else await own(tx, actor, attemptId, true);
    await tx.examAttempt.delete({ where: { id: attemptId } });
    emitDiagnostic({
      message: "Exam attempt deleted",
      userId: actor.userId,
      credentialId: actor.credentialId,
      projectId: row.projectId,
      event: "exam.attempt.deleted",
      details: { attemptId, examId: row.examId },
    });
  });
}
export async function getOwnAttempt(
  db: Db,
  actor: ProjectActor,
  attemptId: string,
  now = new Date(),
) {
  return ownView(db, await own(db, actor, attemptId), now);
}
async function finalizeAttemptInTx(
  tx: Prisma.TransactionClient,
  attemptId: string,
  kind: ExamSubmissionKind,
  now: Date,
) {
  const row = await lockAttempt(tx, attemptId);
  if (row.status !== "in_progress") return row;
  const snapshot = examSnapshotSchema.parse(row.definitionSnapshot);
  const answers = await tx.examAnswer.findMany({ where: { attemptId } });
  for (const q of snapshot.questions)
    if (q.kind === "multiple_choice") {
      const answer = answers.find((a) => a.questionId === q.id);
      const autoScore = autoScoreFor(q, answer?.selectedChoiceIds ?? []);
      await tx.examAnswer.upsert({
        where: { attemptId_questionId: { attemptId, questionId: q.id } },
        create: {
          attemptId,
          questionId: q.id,
          kind: q.kind,
          sequence: 0,
          savedAt: now,
          autoScore,
        },
        update: { autoScore },
      });
    }
  const updated = await tx.examAttempt.update({
    where: { id: attemptId },
    data: {
      status: "submitted",
      submissionKind: kind,
      submittedAt: kind === "timeout" ? row.deadlineAt : now,
      revision: { increment: 1 },
    },
  });
  emitDiagnostic({
    message: "Exam state changed",
    event:
      kind === "timeout" ? "exam.attempt.expired" : "exam.attempt.submitted",
    details: { attemptId, examId: row.examId, projectId: row.projectId },
  });
  return updated;
}
export async function startAttempt(
  db: PrismaClient,
  actor: ProjectActor,
  input: { examId: string },
  now = new Date(),
): Promise<TraineeAttemptView> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Exam" WHERE id = ${input.examId}::uuid FOR UPDATE`;
    const exam = await loadExamDefinitionInTx(tx, input.examId);
    if (!exam) throw new CoreError("NOT_FOUND");
    await assertTrainee(tx, exam.projectId, actor, {
      capability: "content:write",
    });
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`weaver:exam-attempt:${exam.id}:${actor.userId}`}, 0))::text`;
    const open = await tx.examAttempt.findFirst({
      where: {
        examId: exam.id,
        traineeId: actor.userId,
        status: "in_progress",
      },
    });
    if (open) {
      if (expired(open, now))
        await finalizeAttemptInTx(tx, open.id, "timeout", now);
      else return ownView(tx, open, now);
    }
    if (exam.status !== "published")
      throw new CoreError("PRECONDITION_FAILED", "This exam is not open");
    const attemptNumber =
      ((
        await tx.examAttempt.aggregate({
          where: { examId: exam.id, traineeId: actor.userId },
          _max: { attemptNumber: true },
        })
      )._max.attemptNumber ?? 0) + 1;
    const row = await tx.examAttempt.create({
      data: {
        examId: exam.id,
        projectId: exam.projectId,
        traineeId: actor.userId,
        attemptNumber,
        examRevision: exam.revision,
        definitionSnapshot: shuffleChoices(snapshotOf(exam)),
        maxScore: exam.maxScore,
        startedAt: now,
        deadlineAt: new Date(now.getTime() + exam.timeLimitMinutes * 60_000),
      },
    });
    emitDiagnostic({
      message: "Exam attempt started",
      userId: actor.userId,
      credentialId: actor.credentialId,
      projectId: row.projectId,
      event: "exam.attempt.started",
      details: {
        attemptId: row.id,
        examId: exam.id,
        projectId: exam.projectId,
      },
    });
    return ownView(tx, row, now);
  });
}
export async function saveAnswer(
  db: PrismaClient,
  actor: ProjectActor,
  input: { attemptId: string; answer: ExamAnswerInput },
  now = new Date(),
): Promise<SaveAnswerResult> {
  return db.$transaction(async (tx) => {
    const row = await lockAttempt(tx, input.attemptId);
    await own(tx, actor, row.id, true);
    const parsed = examAnswerInputSchema.safeParse(input.answer);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      throw new CoreError("BAD_REQUEST", issue.message, {
        field: issue.path.join("."),
      });
    }
    const answer = parsed.data;
    const existing = await tx.examAnswer.findUnique({
      where: {
        attemptId_questionId: {
          attemptId: row.id,
          questionId: input.answer.questionId,
        },
      },
    });
    const result = (
      outcome: SaveAnswerResult["outcome"],
      sequence = existing?.sequence ?? 0,
      savedAt = existing?.savedAt ?? null,
    ): SaveAnswerResult => ({
      outcome,
      sequence,
      savedAt,
      timing: timing(row, now),
    });
    if (row.status !== "in_progress") return result("closed");
    if (expired(row, now)) return result("expired");
    const q = examSnapshotSchema
      .parse(row.definitionSnapshot)
      .questions.find((q) => q.id === answer.questionId);
    if (!q)
      throw new CoreError("BAD_REQUEST", "Unknown question", {
        field: "questionId",
      });
    const selected = answer.selectedChoiceIds ?? [];
    if (
      q.kind === "multiple_choice"
        ? answer.text != null ||
          selected.some((id) => !q.choices?.some((c) => c.id === id)) ||
          new Set(selected).size !== selected.length ||
          (!q.allowMultiple && selected.length > 1)
        : selected.length > 0
    )
      throw new CoreError("BAD_REQUEST", "Answer does not match the question", {
        field: q.kind === "multiple_choice" ? "selectedChoiceIds" : "text",
      });
    const saved = await tx.$queryRaw<Array<{ sequence: number }>>`
      INSERT INTO "ExamAnswer" ("id", "attemptId", "questionId", "kind", "selectedChoiceIds", "text", "sequence", "savedAt")
      VALUES (${randomUUID()}::uuid, ${row.id}::uuid, ${q.id}::uuid, ${q.kind}::"ExamQuestionKind",
        ${selected}::text[], ${answer.text ?? null}, ${answer.sequence},
        (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'))
      ON CONFLICT ("attemptId", "questionId") DO UPDATE SET
        "selectedChoiceIds" = EXCLUDED."selectedChoiceIds", "text" = EXCLUDED."text",
        "sequence" = EXCLUDED."sequence", "savedAt" = EXCLUDED."savedAt"
      WHERE "ExamAnswer"."sequence" < EXCLUDED."sequence"
      RETURNING "sequence"
    `;
    return saved.length
      ? result("saved", answer.sequence, now)
      : result("stale");
  });
}
export async function submitAttempt(
  db: PrismaClient,
  actor: ProjectActor,
  input: { attemptId: string },
  now = new Date(),
): Promise<TraineeAttemptView> {
  return db.$transaction(async (tx) => {
    const row = await lockAttempt(tx, input.attemptId);
    await own(tx, actor, row.id, true);
    const updated = await finalizeAttemptInTx(
      tx,
      row.id,
      now > row.deadlineAt ? "timeout" : "manual",
      now,
    );
    return ownView(tx, updated, now);
  });
}
export async function finalizeExpiredAttempts(
  db: PrismaClient,
  now = new Date(),
): Promise<{ expired: number }> {
  let count = 0;
  for (;;) {
    const n = await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT "id" FROM "ExamAttempt" WHERE "status" = 'in_progress' AND "deadlineAt" < ${new Date(now.getTime() - ATTEMPT_GRACE_MS)} ORDER BY "id" LIMIT 100 FOR UPDATE SKIP LOCKED`;
      for (const row of rows)
        await finalizeAttemptInTx(tx, row.id, "timeout", now);
      return rows.length;
    });
    count += n;
    if (n < 100) return { expired: count };
  }
}
async function listItem(
  db: Db,
  row: ExamAttempt,
  now: Date,
): Promise<AttemptListItem> {
  const trainee = await db.user.findUniqueOrThrow({
    where: { id: row.traineeId },
    select: { id: true, name: true, email: true },
  });
  const project = await db.project.findUniqueOrThrow({
    where: { id: row.projectId },
    select: { name: true },
  });
  const r = effectiveAttempt(row, now);
  return {
    id: r.id,
    examId: r.examId,
    examTitle: examSnapshotSchema.parse(r.definitionSnapshot).title,
    projectId: r.projectId,
    projectName: project.name,
    trainee,
    attemptNumber: r.attemptNumber,
    status: r.status,
    startedAt: r.startedAt,
    deadlineAt: r.deadlineAt,
    submittedAt: r.submittedAt,
    submissionKind: r.submissionKind,
    gradedAt: r.gradedAt,
    gradedByName: r.gradedByName,
    gradedVia: r.gradedVia,
    releasedAt: r.releasedAt,
    releasedByName: r.releasedByName,
    totalScore: r.totalScore,
    maxScore: r.maxScore,
    percent: r.percent,
    passed: r.passed,
    revision: r.revision,
  };
}
export async function listAttempts(
  db: Db,
  actor: ProjectActor,
  input: {
    projectIds: readonly string[];
    examId?: string;
    status?: "waiting" | "in_review" | "released" | "in_progress";
    cursor?: string;
    limit?: number;
  },
  now = new Date(),
): Promise<{ items: AttemptListItem[]; nextCursor: string | null }> {
  const projects = await trainerProjectIds(db, actor, input.projectIds);
  if (input.projectIds.length === 1 && !projects.length) {
    await resolveProjectAccess(db, input.projectIds[0]!, actor);
    throw new CoreError("FORBIDDEN");
  }
  const cutoff = new Date(now.getTime() - ATTEMPT_GRACE_MS);
  const status: Prisma.ExamAttemptWhereInput =
    input.status === "waiting"
      ? {
          OR: [
            { status: "submitted" },
            { status: "in_progress", deadlineAt: { lt: cutoff } },
          ],
        }
      : input.status === "in_progress"
        ? { status: "in_progress", deadlineAt: { gte: cutoff } }
        : input.status
          ? { status: input.status }
          : {};
  const cursor = input.cursor
    ? decodeTimestampIdPageCursor(input.cursor)
    : null;
  const limit = Math.max(1, Math.min(100, input.limit ?? 50));
  const rows = await db.examAttempt.findMany({
    where: {
      projectId: { in: projects },
      examId: input.examId,
      AND: [
        status,
        ...(cursor
          ? [
              {
                OR: [
                  { startedAt: { lt: cursor[0] } },
                  { startedAt: cursor[0], id: { lt: cursor[1] } },
                ],
              },
            ]
          : []),
      ],
    },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const items: AttemptListItem[] = [];
  for (const row of rows.slice(0, limit))
    items.push(await listItem(db, row, now));
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodePageCursor([last.startedAt.toISOString(), last.id])
        : null,
  };
}
export async function getAttemptForReview(
  db: Db,
  actor: ProjectActor,
  attemptId: string,
  now = new Date(),
): Promise<ReviewAttemptView> {
  const row = await db.examAttempt.findUnique({ where: { id: attemptId } });
  if (!row) throw new CoreError("NOT_FOUND");
  await assertTrainer(db, row.projectId, actor, { capability: "content:read" });
  return reviewView(db, row, now);
}
async function reviewView(
  db: Db,
  row: ExamAttempt,
  now: Date,
): Promise<ReviewAttemptView> {
  const answers = await db.examAnswer.findMany({
    where: { attemptId: row.id },
  });
  const snapshot = examSnapshotSchema.parse(row.definitionSnapshot);
  return {
    ...(await listItem(db, row, now)),
    snapshot,
    overallFeedback: row.overallFeedback,
    answers: snapshot.questions.map((q) => {
      const a = answers.find((a) => a.questionId === q.id);
      return {
        questionId: q.id,
        selectedChoiceIds: a?.selectedChoiceIds ?? [],
        text: a?.text ?? null,
        savedAt: a?.savedAt ?? null,
        autoScore:
          a?.autoScore ??
          (effectiveAttempt(row, now).status !== "in_progress"
            ? autoScoreFor(q, a?.selectedChoiceIds ?? [])
            : null),
        score: a?.score ?? null,
        rationale: a?.rationale ?? null,
      };
    }),
  };
}
export async function gradeAttempt(
  db: PrismaClient,
  actor: ProjectActor,
  input: GradeAttemptCommand,
  now = new Date(),
) {
  return db.$transaction((tx) => gradeAttemptInTx(tx, actor, input, now));
}
export async function gradeAttemptInTx(
  tx: Prisma.TransactionClient,
  actor: ProjectActor,
  input: GradeAttemptCommand,
  now: Date,
): Promise<ReviewAttemptView> {
  let row = await lockAttempt(tx, input.attemptId);
  await assertTrainer(tx, row.projectId, actor);
  if (row.revision !== input.expectedRevision)
    throw new CoreError("CONFLICT", "The attempt changed");
  const previousStatus = row.status;
  if (expired(row, now))
    row = await finalizeAttemptInTx(tx, row.id, "timeout", now);
  if (row.status === "in_progress")
    throw new CoreError(
      "PRECONDITION_FAILED",
      "The attempt is still in progress",
    );
  const parsed = gradeAttemptInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new CoreError("BAD_REQUEST", issue.message, {
      field: issue.path.join("."),
    });
  }
  const command = parsed.data;
  if (command.release) {
    assertSessionPrincipal(actor);
    if (input.via === "assistant") throw new CoreError("FORBIDDEN");
  } else if (row.status === "released")
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Already released; a trainer changes it in Weaver",
    );
  const snapshot = examSnapshotSchema.parse(row.definitionSnapshot);
  const seen = new Set<string>();
  for (const [i, g] of command.grades.entries()) {
    const q = snapshot.questions.find((q) => q.id === g.questionId);
    const fail = (field: string, message: string): never => {
      throw new CoreError("BAD_REQUEST", message, {
        field: `grades.${i}.${field}`,
      });
    };
    if (!q || seen.has(g.questionId))
      fail("questionId", "Unknown or duplicate question");
    seen.add(g.questionId);
    if (g.score > q!.weight) fail("score", "Score exceeds question weight");
    if (q!.kind === "free_text" && !g.rationale?.trim())
      fail("rationale", "A scored free-text answer needs a rationale");
  }
  let answers = await tx.examAnswer.findMany({ where: { attemptId: row.id } });
  for (const q of snapshot.questions) {
    const grade = command.grades.find((g) => g.questionId === q.id);
    const old = answers.find((a) => a.questionId === q.id);
    if (!grade && (q.kind !== "multiple_choice" || old?.score != null))
      continue;
    const score =
      grade?.score ??
      old?.autoScore ??
      autoScoreFor(q, old?.selectedChoiceIds ?? []);
    const suppliedRationale = grade?.rationale?.trim();
    let rationale = autoRationaleFor(q, old?.selectedChoiceIds ?? []);
    if (suppliedRationale) rationale = suppliedRationale;
    await tx.examAnswer.upsert({
      where: { attemptId_questionId: { attemptId: row.id, questionId: q.id } },
      create: {
        attemptId: row.id,
        questionId: q.id,
        kind: q.kind,
        sequence: 0,
        savedAt: now,
        score,
        rationale,
      },
      update: { score, rationale },
    });
  }
  answers = await tx.examAnswer.findMany({ where: { attemptId: row.id } });
  const scores = new Map(
    answers.filter((a) => a.score != null).map((a) => [a.questionId, a.score!]),
  );
  const totals = summarizeScores({
    questions: snapshot.questions,
    scores,
    passingPercent: snapshot.passingPercent,
  });
  if (command.release && !totals) {
    const missing = snapshot.questions.find((q) => !scores.has(q.id));
    throw new CoreError(
      "BAD_REQUEST",
      `Missing score for question ${missing?.id}`,
      { field: "grades" },
    );
  }
  const user = await tx.user.findUniqueOrThrow({
    where: { id: actor.userId },
    select: { name: true },
  });
  const via = input.via ?? actor.authenticationMethod;
  const graded = await tx.examAttempt.update({
    where: { id: row.id },
    data: {
      status: command.release ? "released" : "in_review",
      gradedAt: now,
      gradedById: actor.userId,
      gradedByName: user.name,
      gradedVia: via,
      overallFeedback: command.overallFeedback,
      totalScore: totals?.totalScore ?? null,
      percent: totals?.percent ?? null,
      passed: totals?.passed ?? null,
      ...(command.release
        ? {
            releasedAt: now,
            releasedById: actor.userId,
            releasedByName: user.name,
          }
        : {}),
      revision: { increment: 1 },
    },
  });
  emitDiagnostic({
    message: "Exam attempt graded",
    userId: actor.userId,
    credentialId: actor.credentialId,
    projectId: row.projectId,
    event: "exam.attempt.graded",
    details: {
      attemptId: row.id,
      examId: row.examId,
      projectId: row.projectId,
      via,
      status: command.release ? "released" : "in_review",
      gradedQuestions: scores.size,
      revised: previousStatus !== "submitted",
    },
  });
  if (command.release)
    emitDiagnostic({
      message: "Exam attempt released",
      userId: actor.userId,
      credentialId: actor.credentialId,
      projectId: row.projectId,
      event: "exam.attempt.released",
      details: {
        attemptId: row.id,
        examId: row.examId,
        projectId: row.projectId,
        via,
        status: "released",
        gradedQuestions: scores.size,
        rerelease: previousStatus === "released",
      },
    });
  return reviewView(tx, graded, now);
}
