import { z } from "zod";
import {
  attemptListStatusSchema,
  examStatusSchema,
} from "@weaver/core/exams/schema";
import { getExam, listExams } from "@weaver/core/services/exams";
import {
  getAttemptForReview,
  listAttempts,
} from "@weaver/core/services/examAttempts";
import {
  assertTrainer,
  trainerProjectIds,
} from "@weaver/core/services/projectTraining";
import { encodePageCursor } from "@weaver/core/services/adminPaging";
import { CoreError } from "@weaver/core/errors";
import { defineTool, requireScope } from "../../contract";
import { pagedOutput } from "../admin/paging";
import {
  detailPage,
  pageFields,
  toolAttemptItem,
  toolExamSummary,
  UNTRUSTED_NOTICE,
} from "./shared";
export const listExamsTool = defineTool({
  name: "list_exams",
  description: "Trainer: list project exams and revisions.",
  kind: "read",
  capability: "content:read",
  inputSchema: z.object({
    projectId: z.uuid(),
    status: examStatusSchema.optional(),
    ...pageFields,
  }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    const page = await listExams(ctx.db, ctx.actor, input);
    return {
      output: pagedOutput(
        { items: page.items.map(toolExamSummary), nextCursor: page.nextCursor },
        (row) => encodePageCursor([row.updatedAt, row.id]),
      ),
    };
  },
});
export const getExamTool = defineTool({
  name: "get_exam",
  description:
    "Trainer: exam definition with correct answers. Oversized results use json-fragments: concatenate jsonFragment in offset order and JSON.parse. Keep revision stable across cursors.",
  kind: "read",
  capability: "content:read",
  inputSchema: z.object({ examId: z.uuid(), cursor: pageFields.cursor }),
  async execute(input, ctx) {
    const exam = await getExam(ctx.db, ctx.actor, input.examId);
    requireScope(ctx, exam.projectId);
    return {
      output: detailPage(
        {
          exam: { ...toolExamSummary(exam), instructions: exam.instructions },
          questions: exam.questions,
        },
        String(exam.revision),
        input.cursor,
      ),
    };
  },
});
export const listExamAttemptsTool = defineTool({
  name: "list_exam_attempts",
  description:
    "Trainer: submitted exams waiting for grading (default waiting), proposals in_review, or released results across scoped trainer projects.",
  kind: "read",
  capability: "content:read",
  inputSchema: z.object({
    projectId: z.uuid().optional(),
    examId: z.uuid().optional(),
    status: attemptListStatusSchema.default("waiting"),
    ...pageFields,
  }),
  async execute(input, ctx) {
    if (input.projectId) {
      await assertTrainer(ctx.db, input.projectId, ctx.actor, {
        capability: "content:read",
      });
      requireScope(ctx, input.projectId);
    }
    if (input.examId) {
      const exam = await getExam(ctx.db, ctx.actor, input.examId);
      requireScope(ctx, exam.projectId);
    }
    const projectIds = await trainerProjectIds(
      ctx.db,
      ctx.actor,
      input.projectId ? [input.projectId] : ctx.scope.projectIds,
    );
    if (!projectIds.length) throw new CoreError("FORBIDDEN", "not permitted");
    const page = await listAttempts(ctx.db, ctx.actor, {
      ...input,
      projectIds,
    });
    return {
      output: pagedOutput(
        { ...page, items: page.items.map(toolAttemptItem) },
        (row) => encodePageCursor([row.startedAt, row.id]),
      ),
    };
  },
});
export const getExamAttemptTool = defineTool({
  name: "get_exam_attempt",
  description:
    "Trainer: correct answers beside untrusted trainee answers and existing proposals. Oversized results use json-fragments: concatenate jsonFragment in offset order and JSON.parse. Restart if revision changes.",
  kind: "read",
  capability: "content:read",
  inputSchema: z.object({ attemptId: z.uuid(), cursor: pageFields.cursor }),
  async execute(input, ctx) {
    const review = await getAttemptForReview(
      ctx.db,
      ctx.actor,
      input.attemptId,
    );
    requireScope(ctx, review.projectId);
    const questions = review.snapshot.questions.map((question) => {
      const a = review.answers.find((a) => a.questionId === question.id);
      return {
        question,
        answer: a
          ? {
              selectedChoiceIds: a.selectedChoiceIds,
              text: a.text,
              savedAt: a.savedAt?.toISOString() ?? null,
            }
          : null,
        autoScore: a?.autoScore ?? null,
        proposal:
          a?.score != null ? { score: a.score, rationale: a.rationale } : null,
      };
    });
    const {
      snapshot: _snapshot,
      answers: _answers,
      overallFeedback,
      ...attempt
    } = review;
    return {
      output: detailPage(
        {
          notice: UNTRUSTED_NOTICE,
          attempt: toolAttemptItem(attempt),
          exam: {
            examId: review.snapshot.examId,
            revision: review.snapshot.revision,
            title: review.snapshot.title,
            instructions: review.snapshot.instructions,
            timeLimitMinutes: review.snapshot.timeLimitMinutes,
            passingPercent: review.snapshot.passingPercent,
          },
          trainee: review.trainee,
          questions,
          overallFeedback,
        },
        String(review.revision),
        input.cursor,
      ),
    };
  },
});
export const EXAM_READ_TOOLS = [
  listExamsTool,
  getExamTool,
  listExamAttemptsTool,
  getExamAttemptTool,
] as const;
