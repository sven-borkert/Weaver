import { z } from "zod";
import {
  examDefinitionInputSchema,
  examGradeEntrySchema,
  examStatusSchema,
} from "@weaver/core/exams/schema";
import { createExamInTx, updateExamInTx } from "@weaver/core/services/exams";
import { gradeAttemptInTx } from "@weaver/core/services/examAttempts";
import { withExamOperation } from "@weaver/core/services/examOperations";
import { assertTrainer } from "@weaver/core/services/projectTraining";
import { hasCapability } from "@weaver/core/security/context";
import { CoreError } from "@weaver/core/errors";
import { defineTool, requireScope, type ToolContext } from "../../contract";
import {
  examQuestionCreateInput,
  examQuestionUpdateInput,
  toolExamSummary,
} from "./shared";
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/);
const revision = z.number().int().positive();
function writeScope(ctx: ToolContext, projectId: string) {
  if (!hasCapability(ctx.actor, "content:write"))
    throw new CoreError("FORBIDDEN");
  requireScope(ctx, projectId);
}
const fields = {
  ...examDefinitionInputSchema.shape,
  questions: z.array(examQuestionCreateInput).max(100),
};
export const createExamTool = defineTool({
  name: "create_exam",
  description:
    "Trainer: create an exam, draft by default. Publish only when requested. Weaver assigns question and choice ids. Every question must be self-contained: include referenced example code in prompt as fenced Markdown code blocks with a language. Reuse idempotencyKey only for identical retries.",
  kind: "write",
  capability: "content:write",
  inputSchema: z.object({
    projectId: z.uuid(),
    idempotencyKey,
    ...fields,
    status: z.enum(["draft", "published"]).optional(),
  }),
  async execute(input, ctx) {
    writeScope(ctx, input.projectId);
    await assertTrainer(ctx.db, input.projectId, ctx.actor);
    const { idempotencyKey: key, projectId, status, ...definition } = input;
    return {
      output: await withExamOperation(
        ctx.db,
        ctx.actor,
        {
          idempotencyKey: key,
          toolName: "create_exam",
          request: { projectId, status, ...definition },
        },
        async (tx) => {
          const exam = await createExamInTx(tx, ctx.actor, {
            projectId,
            status,
            definition,
          });
          return {
            exam: {
              ...toolExamSummary(exam),
              questionIds: exam.questions.map((q) => q.id),
            },
          };
        },
        (tx) => assertTrainer(tx, projectId, ctx.actor),
      ),
    };
  },
});
export const updateExamTool = defineTool({
  name: "update_exam",
  description:
    "Trainer: edit an exam for future attempts; expectedRevision from get_exam. Send only changed fields. questions replaces the whole list: keep a question by passing its id, omit id for new ones. Put referenced code in prompt as fenced Markdown blocks. Attempt snapshots are preserved.",
  kind: "write",
  capability: "content:write",
  inputSchema: z.object({
    examId: z.uuid(),
    idempotencyKey,
    expectedRevision: revision,
    title: fields.title.optional(),
    instructions: z.string().max(20000).optional(),
    timeLimitMinutes: fields.timeLimitMinutes.optional(),
    passingPercent: fields.passingPercent,
    questions: z.array(examQuestionUpdateInput).max(100).optional(),
    status: examStatusSchema.optional(),
  }),
  async execute(input, ctx) {
    const old = await ctx.db.exam.findUnique({
      where: { id: input.examId },
      select: { projectId: true },
    });
    if (!old) throw new CoreError("NOT_FOUND");
    writeScope(ctx, old.projectId);
    await assertTrainer(ctx.db, old.projectId, ctx.actor);
    const {
      idempotencyKey: key,
      examId,
      expectedRevision,
      status,
      ...definition
    } = input;
    return {
      output: await withExamOperation(
        ctx.db,
        ctx.actor,
        {
          idempotencyKey: key,
          toolName: "update_exam",
          request: { examId, expectedRevision, status, ...definition },
        },
        async (tx) => {
          const exam = await updateExamInTx(tx, ctx.actor, {
            examId,
            expectedRevision,
            status,
            definition,
          });
          return {
            exam: {
              ...toolExamSummary(exam),
              questionIds: exam.questions.map((q) => q.id),
            },
          };
        },
        (tx) => assertTrainer(tx, old.projectId, ctx.actor),
      ),
    };
  },
});
export const gradeExamAttemptTool = defineTool({
  name: "grade_exam_attempt",
  description:
    "Trainer: propose scores for review and release in Weaver. Trainees see nothing until release. Every scored free-text question needs a short rationale. Use expectedRevision from get_exam_attempt.",
  kind: "write",
  capability: "content:write",
  inputSchema: z.object({
    attemptId: z.uuid(),
    idempotencyKey,
    expectedRevision: revision,
    grades: z.array(examGradeEntrySchema).max(100),
    overallFeedback: z.string().max(10000).nullable().optional(),
  }),
  async execute(input, ctx) {
    const old = await ctx.db.examAttempt.findUnique({
      where: { id: input.attemptId },
      select: { projectId: true },
    });
    if (!old) throw new CoreError("NOT_FOUND");
    writeScope(ctx, old.projectId);
    await assertTrainer(ctx.db, old.projectId, ctx.actor);
    const { idempotencyKey: key, ...request } = input;
    return {
      output: await withExamOperation(
        ctx.db,
        ctx.actor,
        { idempotencyKey: key, toolName: "grade_exam_attempt", request },
        async (tx) => {
          const a = await gradeAttemptInTx(
            tx,
            ctx.actor,
            {
              ...request,
              release: false,
              via: ctx.run ? "assistant" : undefined,
            },
            new Date(),
          );
          return {
            attempt: {
              id: a.id,
              status: a.status,
              revision: a.revision,
              totalScore: a.totalScore,
              maxScore: a.maxScore,
              percent: a.percent,
              passed: a.passed,
              gradedAt: a.gradedAt?.toISOString() ?? null,
            },
          };
        },
        (tx) => assertTrainer(tx, old.projectId, ctx.actor),
      ),
    };
  },
});
export const EXAM_WRITE_TOOLS = [
  createExamTool,
  updateExamTool,
  gradeExamAttemptTool,
] as const;
