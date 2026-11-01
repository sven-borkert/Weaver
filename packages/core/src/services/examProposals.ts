import { diffLines } from "diff";
import { z } from "zod";
import type { Prisma } from "@weaver/db/client";
import { CoreError } from "../errors";
import {
  examDefinitionInputSchema,
  examQuestionInputSchema,
  examStatusSchema,
  type ExamDefinitionInput,
} from "../exams/schema";
import type { SecurityContext } from "../security/context";
import {
  createExamInTx,
  loadExamDetailInTx,
  mergeExamDefinition,
  updateExamInTx,
  validateExamDefinition,
  type Db,
  type ExamDetail,
} from "./exams";
import { assertTrainer } from "./projectTraining";

/** Exams live in PostgreSQL, so their proposals never join the Git-backed contentOperationSchema. */
export const examProposalOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exam.create"),
    projectId: z.uuid(),
    status: z.enum(["draft", "published"]).optional(),
    definition: examDefinitionInputSchema,
  }),
  z.object({
    kind: z.literal("exam.update"),
    projectId: z.uuid(),
    examId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    status: examStatusSchema.optional(),
    definition: z.object({
      title: z.string().trim().min(1).max(200).optional(),
      instructions: z.string().max(20000).optional(),
      timeLimitMinutes: z.number().int().min(1).max(1440).optional(),
      passingPercent: z.number().int().min(0).max(100).nullable().optional(),
      questions: z.array(examQuestionInputSchema).max(100).optional(),
    }),
  }),
]);
export type ExamProposalOperation = z.infer<typeof examProposalOperationSchema>;
export type ExamProposalOperationInput = z.input<
  typeof examProposalOperationSchema
>;
export type ExamProposalKind = ExamProposalOperation["kind"];

export const isExamProposalKind = (kind: string): kind is ExamProposalKind =>
  kind === "exam.create" || kind === "exam.update";

const MAX_PREVIEW_LINES = 2_000;

function block(text: string, indent = ""): string[] {
  return text.length ? text.split("\n").map((line) => indent + line) : [];
}

/** The reviewer reads the whole definition, correct choices included; proposals are owner-only. */
export function renderExamDefinition(
  definition: ExamDefinitionInput,
  status: string,
): string {
  const questions = definition.questions;
  const choice = questions.filter((q) => q.kind === "multiple_choice").length;
  const maxScore = questions.reduce((sum, q) => sum + q.weight, 0);
  const lines = [
    `Title: ${definition.title}`,
    `Status: ${status}`,
    `Time limit: ${definition.timeLimitMinutes} minutes`,
    `Passing score: ${definition.passingPercent == null ? "none" : `${definition.passingPercent}%`}`,
    `Questions: ${questions.length} (${choice} multiple choice, ${questions.length - choice} free text), max score ${maxScore}`,
  ];
  if (definition.instructions)
    lines.push("", "Instructions:", ...block(definition.instructions, "  "));
  for (const [index, q] of questions.entries()) {
    lines.push(
      "",
      `Question ${index + 1} · ${q.kind === "multiple_choice" ? "multiple choice" : "free text"} · weight ${q.weight}${q.allowMultiple ? " · multiple answers" : ""}`,
      ...block(q.prompt, "  "),
    );
    for (const c of q.choices ?? [])
      lines.push(`  [${c.correct ? "x" : " "}] ${c.text.replace(/\n/g, " ")}`);
    if (q.expectedAnswer)
      lines.push("  Expected answer:", ...block(q.expectedAnswer, "    "));
  }
  return lines.join("\n") + "\n";
}

function linePreview(from: string, to: string) {
  const lines = diffLines(from, to).flatMap((part) => {
    const type = part.added ? "add" : part.removed ? "del" : "same";
    return part.value
      .split("\n")
      .filter((line, index, all) => index < all.length - 1 || line.length > 0)
      .map((text) => ({ type, text }));
  });
  return {
    kind: "document" as const,
    lines: lines.slice(0, MAX_PREVIEW_LINES),
    truncated: lines.length > MAX_PREVIEW_LINES,
  };
}

async function currentExam(
  db: Db,
  operation: Extract<ExamProposalOperation, { kind: "exam.update" }>,
): Promise<ExamDetail> {
  const exam = await loadExamDetailInTx(db, operation.examId);
  if (exam?.projectId !== operation.projectId) throw new CoreError("NOT_FOUND");
  return exam;
}

/** Runs the checks acceptance would run, so the model can correct itself before the user reviews. */
export async function prepareExamProposal(
  db: Db,
  actor: SecurityContext,
  operation: ExamProposalOperation,
): Promise<{ resourceId: string | null; preview: unknown }> {
  await assertTrainer(db, operation.projectId, actor, {
    capability: "content:propose",
  });
  if (operation.kind === "exam.create") {
    const index = operation.definition.questions.findIndex((q) => q.id);
    if (index >= 0)
      throw new CoreError(
        "BAD_REQUEST",
        "Omit question ids when creating an exam; Weaver assigns them",
        { field: `questions.${index}.id` },
      );
    const status = operation.status ?? "draft";
    const definition = validateExamDefinition(operation.definition, status);
    return {
      resourceId: null,
      preview: linePreview("", renderExamDefinition(definition, status)),
    };
  }
  const old = await currentExam(db, operation);
  if (old.revision !== operation.expectedRevision)
    throw new CoreError(
      "CONFLICT",
      "The exam changed; call get_exam again and use its revision",
    );
  const known = new Set(old.questions.map((q) => q.id));
  for (const [index, q] of (operation.definition.questions ?? []).entries())
    if (q.id && !known.has(q.id))
      throw new CoreError(
        "BAD_REQUEST",
        "Unknown question id; use an id from get_exam or omit it for a new question",
        { field: `questions.${index}.id` },
      );
  const status = operation.status ?? old.status;
  const definition = validateExamDefinition(
    mergeExamDefinition(old, operation.definition),
    status,
  );
  return {
    resourceId: old.id,
    preview: linePreview(
      renderExamDefinition(mergeExamDefinition(old), old.status),
      renderExamDefinition(definition, status),
    ),
  };
}

export type ExamApplyResult =
  | { ok: true; examId: string; revision: number }
  | { ok: false; reason: string };

/** Applies inside the caller's transaction; a stale or missing exam conflicts instead of writing. */
export async function applyExamProposalInTx(
  tx: Prisma.TransactionClient,
  actor: SecurityContext,
  operation: ExamProposalOperation,
): Promise<ExamApplyResult> {
  await assertTrainer(tx, operation.projectId, actor);
  if (operation.kind === "exam.create") {
    const exam = await createExamInTx(tx, actor, {
      projectId: operation.projectId,
      status: operation.status,
      definition: operation.definition,
    });
    return { ok: true, examId: exam.id, revision: exam.revision };
  }
  await tx.$queryRaw`SELECT "id" FROM "Exam" WHERE "id" = ${operation.examId}::uuid FOR UPDATE`;
  const old = await loadExamDetailInTx(tx, operation.examId);
  if (old?.projectId !== operation.projectId)
    return { ok: false, reason: "exam no longer exists" };
  if (old.revision !== operation.expectedRevision)
    return { ok: false, reason: "exam changed since this was proposed" };
  const exam = await updateExamInTx(tx, actor, {
    examId: operation.examId,
    expectedRevision: operation.expectedRevision,
    status: operation.status,
    definition: operation.definition,
  });
  return { ok: true, examId: exam.id, revision: exam.revision };
}
