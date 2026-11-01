import {
  clampLimit,
  decodeTimestampIdPageCursor,
  encodePageCursor,
} from "./adminPaging";
import { randomUUID } from "node:crypto";
import {
  Prisma,
  type PrismaClient,
  type ExamStatus,
  type ExamQuestionKind,
  type ExamAttemptStatus,
  type ExamSubmissionKind,
} from "@weaver/db/client";
import { CoreError } from "../errors";
import {
  examDefinitionInputSchema,
  type ExamDefinitionInput,
  type ExamSnapshot,
} from "../exams/schema";
import { emitDiagnostic } from "../diagnostics/writer";
import { assertTrainer, assertTrainee } from "./projectTraining";
import type { ProjectActor } from "./projectAccess";
export type Db = PrismaClient | Prisma.TransactionClient;
export type ExamAttemptCounts = {
  inProgress: number;
  waiting: number;
  inReview: number;
  released: number;
};
export type ExamSummary = {
  id: string;
  projectId: string;
  title: string;
  status: ExamStatus;
  timeLimitMinutes: number;
  passingPercent: number | null;
  revision: number;
  questionCount: number;
  maxScore: number;
  attemptCounts: ExamAttemptCounts;
  createdAt: Date;
  updatedAt: Date;
};
export type ExamQuestionView = {
  id: string;
  position: number;
  kind: ExamQuestionKind;
  prompt: string;
  weight: number;
  choices: Array<{ id: string; text: string; correct: boolean }> | null;
  allowMultiple: boolean;
  expectedAnswer: string | null;
};
export type ExamDetail = ExamSummary & {
  instructions: string;
  questions: ExamQuestionView[];
};
export type TraineeAttemptSummary = {
  id: string;
  examId: string;
  attemptNumber: number;
  status: ExamAttemptStatus;
  startedAt: Date;
  deadlineAt: Date;
  submittedAt: Date | null;
  submissionKind: ExamSubmissionKind | null;
  releasedAt: Date | null;
  totalScore: number | null;
  maxScore: number;
  percent: number | null;
  passed: boolean | null;
};
export type TraineeExamSummary = {
  id: string;
  title: string;
  instructions: string;
  status: "published" | "archived";
  timeLimitMinutes: number;
  passingPercent: number | null;
  questionCount: number;
  maxScore: number;
  attempts: TraineeAttemptSummary[];
  openAttemptId: string | null;
  canStart: boolean;
};
export function effectiveAttempt<
  T extends {
    status: ExamAttemptStatus;
    deadlineAt: Date;
    submittedAt: Date | null;
    submissionKind: ExamSubmissionKind | null;
  },
>(row: T, now: Date): T {
  return row.status === "in_progress" &&
    row.deadlineAt.getTime() + 10_000 < now.getTime()
    ? {
        ...row,
        status: "submitted",
        submittedAt: row.deadlineAt,
        submissionKind: "timeout",
      }
    : row;
}
export function traineeSummary(
  row: TraineeAttemptSummary,
  now: Date,
): TraineeAttemptSummary {
  const r = effectiveAttempt(row, now);
  return {
    id: r.id,
    examId: r.examId,
    attemptNumber: r.attemptNumber,
    status: r.status,
    startedAt: r.startedAt,
    deadlineAt: r.deadlineAt,
    submittedAt: r.submittedAt,
    submissionKind: r.submissionKind,
    releasedAt: r.releasedAt,
    maxScore: r.maxScore,
    totalScore: r.status === "released" ? r.totalScore : null,
    percent: r.status === "released" ? r.percent : null,
    passed: r.status === "released" ? r.passed : null,
  };
}
type ExamDefinition = Omit<ExamDetail, "attemptCounts">;
const emptyAttemptCounts = (): ExamAttemptCounts => ({
  inProgress: 0,
  waiting: 0,
  inReview: 0,
  released: 0,
});
async function attemptCountsByExam(tx: Db, ids: string[], now: Date) {
  if (!ids.length) return new Map<string, ExamAttemptCounts>();
  const cutoff = new Date(now.getTime() - 10_000);
  const rows = await tx.$queryRaw<
    Array<ExamAttemptCounts & { examId: string }>
  >(Prisma.sql`
    SELECT "examId",
      count(*) FILTER (WHERE status = 'in_progress' AND "deadlineAt" >= ${cutoff})::int AS "inProgress",
      count(*) FILTER (WHERE status = 'submitted' OR (status = 'in_progress' AND "deadlineAt" < ${cutoff}))::int AS waiting,
      count(*) FILTER (WHERE status = 'in_review')::int AS "inReview",
      count(*) FILTER (WHERE status = 'released')::int AS released
    FROM "ExamAttempt" WHERE "examId" = ANY(${ids}::uuid[]) GROUP BY "examId"`);
  return new Map(rows.map(({ examId, ...counts }) => [examId, counts]));
}
export async function loadExamDetailInTx(
  tx: Db,
  examId: string,
  now = new Date(),
): Promise<ExamDetail | null> {
  const definition = await loadExamDefinitionInTx(tx, examId);
  if (!definition) return null;
  const counts = await attemptCountsByExam(tx, [examId], now);
  return {
    ...definition,
    attemptCounts: counts.get(examId) ?? emptyAttemptCounts(),
  };
}
export async function loadExamDefinitionInTx(
  tx: Db,
  examId: string,
): Promise<ExamDefinition | null> {
  const row = await tx.exam.findUnique({
    where: { id: examId },
    include: { questions: { orderBy: { position: "asc" } } },
  });
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    instructions: row.instructions,
    status: row.status,
    timeLimitMinutes: row.timeLimitMinutes,
    passingPercent: row.passingPercent,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    questionCount: row.questions.length,
    maxScore: row.questions.reduce((n, q) => n + q.weight, 0),
    questions: row.questions.map((q) => ({
      id: q.id,
      position: q.position,
      kind: q.kind,
      prompt: q.prompt,
      weight: q.weight,
      choices: q.choices as ExamQuestionView["choices"],
      allowMultiple: q.allowMultiple,
      expectedAnswer: q.expectedAnswer,
    })),
  };
}
export async function getExam(
  db: Db,
  actor: ProjectActor,
  examId: string,
  now = new Date(),
): Promise<ExamDetail> {
  const detail = await loadExamDetailInTx(db, examId, now);
  if (!detail) throw new CoreError("NOT_FOUND");
  await assertTrainer(db, detail.projectId, actor, {
    capability: "content:read",
  });
  return detail;
}
export async function listExams(
  db: Db,
  actor: ProjectActor,
  input: {
    projectId: string;
    status?: ExamStatus;
    limit?: number;
    cursor?: string;
  },
  now = new Date(),
): Promise<{ items: ExamSummary[]; nextCursor: string | null }> {
  await assertTrainer(db, input.projectId, actor, {
    capability: "content:read",
  });
  const limit = clampLimit(input.limit, 100);
  const cursor = input.cursor
    ? decodeTimestampIdPageCursor(input.cursor)
    : null;
  const rows = await db.exam.findMany({
    where: {
      projectId: input.projectId,
      status: input.status,
      ...(cursor
        ? {
            OR: [
              { updatedAt: { lt: cursor[0] } },
              { updatedAt: cursor[0], id: { gt: cursor[1] } },
            ],
          }
        : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: limit + 1,
    select: {
      id: true,
      projectId: true,
      title: true,
      status: true,
      timeLimitMinutes: true,
      passingPercent: true,
      revision: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  const page = rows.slice(0, limit);
  const ids = page.map((row) => row.id);
  const counts = await attemptCountsByExam(db, ids, now);
  const questions = await db.examQuestion.groupBy({
    by: ["examId"],
    where: { examId: { in: ids } },
    _count: { _all: true },
    _sum: { weight: true },
  });
  const scores = new Map(questions.map((row) => [row.examId, row]));
  const items = page.map((row) => ({
    ...row,
    questionCount: scores.get(row.id)?._count._all ?? 0,
    maxScore: scores.get(row.id)?._sum.weight ?? 0,
    attemptCounts: counts.get(row.id) ?? emptyAttemptCounts(),
  }));
  const last = page.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodePageCursor([last.updatedAt.toISOString(), last.id])
        : null,
  };
}
export function validateExamDefinition(
  definition: ExamDefinitionInput,
  status: ExamStatus,
) {
  const parsed = examDefinitionInputSchema.safeParse(definition);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new CoreError("BAD_REQUEST", issue.message, {
      field: issue.path.join("."),
    });
  }
  if (status === "published" && !parsed.data.questions.length)
    throw new CoreError("BAD_REQUEST", "Add at least one question", {
      field: "questions",
    });
  return parsed.data;
}
async function writeQuestions(
  tx: Prisma.TransactionClient,
  examId: string,
  questions: ReturnType<typeof validateExamDefinition>["questions"],
) {
  const existing = await tx.examQuestion.findMany({
    where: { examId },
    select: { id: true },
  });
  const ids = new Set(existing.map((q) => q.id));
  const retained = new Set<string>();
  for (const [i, q] of questions.entries())
    if (q.id) {
      if (!ids.has(q.id) || retained.has(q.id))
        throw new CoreError("BAD_REQUEST", "Invalid question id", {
          field: `questions.${i}.id`,
        });
      retained.add(q.id);
    }
  // Move every old position out of the destination range before swaps.
  for (const [i, q] of existing.entries())
    await tx.examQuestion.update({
      where: { id: q.id },
      data: { position: -i - 1 },
    });
  await tx.examQuestion.deleteMany({
    where: { examId, id: { notIn: [...retained] } },
  });
  for (const [position, q] of questions.entries()) {
    const data = {
      position,
      kind: q.kind,
      prompt: q.prompt,
      weight: q.weight,
      choices: q.choices
        ? q.choices.map((c) => ({ ...c, id: c.id ?? randomUUID() }))
        : Prisma.DbNull,
      allowMultiple: q.allowMultiple ?? false,
      expectedAnswer: q.expectedAnswer ?? null,
    };
    if (q.id) await tx.examQuestion.update({ where: { id: q.id }, data });
    else await tx.examQuestion.create({ data: { ...data, examId } });
  }
}
/** Fields an update leaves out keep their stored values; questions replace the whole list. */
export function mergeExamDefinition(
  old: ExamDetail,
  definition: Partial<ExamDefinitionInput> = {},
): ExamDefinitionInput {
  return {
    title: old.title,
    instructions: old.instructions,
    timeLimitMinutes: old.timeLimitMinutes,
    passingPercent: old.passingPercent,
    questions: old.questions.map(({ choices, ...q }) => ({
      ...q,
      ...(choices ? { choices } : {}),
    })),
    ...definition,
  };
}
type CreateInput = {
  projectId: string;
  definition: ExamDefinitionInput;
  status?: "draft" | "published";
};
type UpdateInput = {
  examId: string;
  expectedRevision: number;
  definition?: Partial<ExamDefinitionInput>;
  status?: ExamStatus;
};
export async function createExam(
  db: PrismaClient,
  actor: ProjectActor,
  input: CreateInput,
) {
  return db.$transaction((tx) => createExamInTx(tx, actor, input));
}
export async function createExamInTx(
  tx: Prisma.TransactionClient,
  actor: ProjectActor,
  input: CreateInput,
): Promise<ExamDetail> {
  await assertTrainer(tx, input.projectId, actor);
  await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${input.projectId}::uuid FOR UPDATE`;
  const definition = validateExamDefinition(
    input.definition,
    input.status ?? "draft",
  );
  if ((await tx.exam.count({ where: { projectId: input.projectId } })) >= 500)
    throw new CoreError(
      "PRECONDITION_FAILED",
      "This project has reached the exam limit",
    );
  const { questions, ...data } = definition;
  const row = await tx.exam.create({
    data: {
      ...data,
      passingPercent: data.passingPercent ?? null,
      projectId: input.projectId,
      status: input.status ?? "draft",
      createdById: actor.userId,
    },
  });
  await writeQuestions(tx, row.id, questions);
  emitDiagnostic({
    message: "Exam created",
    userId: actor.userId,
    credentialId: actor.credentialId,
    projectId: row.projectId,
    event: "exam.created",
    details: { examId: row.id, projectId: row.projectId },
  });
  return (await loadExamDetailInTx(tx, row.id))!;
}
export async function updateExam(
  db: PrismaClient,
  actor: ProjectActor,
  input: UpdateInput,
) {
  return db.$transaction((tx) => updateExamInTx(tx, actor, input));
}
export async function updateExamInTx(
  tx: Prisma.TransactionClient,
  actor: ProjectActor,
  input: UpdateInput,
): Promise<ExamDetail> {
  await tx.$queryRaw`SELECT id FROM "Exam" WHERE id = ${input.examId}::uuid FOR UPDATE`;
  const old = await loadExamDetailInTx(tx, input.examId);
  if (!old) throw new CoreError("NOT_FOUND");
  await assertTrainer(tx, old.projectId, actor);
  if (old.revision !== input.expectedRevision)
    throw new CoreError("CONFLICT", "Someone else changed this exam");
  const definition = validateExamDefinition(
    mergeExamDefinition(old, input.definition),
    input.status ?? old.status,
  );
  const { questions, ...data } = definition;
  await writeQuestions(tx, old.id, questions);
  await tx.exam.update({
    where: { id: old.id },
    data: { ...data, status: input.status, revision: { increment: 1 } },
  });
  emitDiagnostic({
    message: "Exam updated",
    userId: actor.userId,
    credentialId: actor.credentialId,
    projectId: old.projectId,
    event: "exam.updated",
    details: { examId: old.id, projectId: old.projectId },
  });
  return (await loadExamDetailInTx(tx, old.id))!;
}
export async function deleteExam(
  db: PrismaClient,
  actor: ProjectActor,
  examId: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Exam" WHERE id = ${examId}::uuid FOR UPDATE`;
    const row = await tx.exam.findUnique({ where: { id: examId } });
    if (!row) throw new CoreError("NOT_FOUND");
    await assertTrainer(tx, row.projectId, actor);
    if (await tx.examAttempt.count({ where: { examId } }))
      throw new CoreError("PRECONDITION_FAILED", "Archive the exam instead");
    await tx.exam.delete({ where: { id: examId } });
    emitDiagnostic({
      message: "Exam deleted",
      userId: actor.userId,
      credentialId: actor.credentialId,
      projectId: row.projectId,
      event: "exam.deleted",
      details: { examId, projectId: row.projectId },
    });
  });
}
export function snapshotOf(exam: ExamDefinition): ExamSnapshot {
  return {
    examId: exam.id,
    revision: exam.revision,
    title: exam.title,
    instructions: exam.instructions,
    timeLimitMinutes: exam.timeLimitMinutes,
    passingPercent: exam.passingPercent,
    questions: exam.questions,
  };
}
export async function listExamsForTrainee(
  db: Db,
  actor: ProjectActor,
  projectId: string,
  now = new Date(),
): Promise<TraineeExamSummary[]> {
  await assertTrainee(db, projectId, actor);
  const rows = await db.exam.findMany({
    where: {
      projectId,
      OR: [
        { status: "published" },
        { status: "archived", attempts: { some: { traineeId: actor.userId } } },
      ],
    },
    include: {
      questions: { select: { weight: true } },
      attempts: {
        where: { traineeId: actor.userId },
        orderBy: { attemptNumber: "desc" },
      },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
  });
  return rows.map((r) => {
    const attempts = r.attempts.map((a) => traineeSummary(a, now));
    const openAttemptId =
      attempts.find((a) => a.status === "in_progress")?.id ?? null;
    return {
      id: r.id,
      title: r.title,
      instructions: r.instructions,
      status: r.status as "published" | "archived",
      timeLimitMinutes: r.timeLimitMinutes,
      passingPercent: r.passingPercent,
      questionCount: r.questions.length,
      maxScore: r.questions.reduce((n, q) => n + q.weight, 0),
      attempts,
      openAttemptId,
      canStart: r.status === "published" && !openAttemptId,
    };
  });
}
