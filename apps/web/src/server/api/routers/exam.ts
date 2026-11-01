import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";
import * as schemas from "~/server/api/schemas/exam";
import * as exams from "@weaver/core/services/exams";
import * as attempts from "@weaver/core/services/examAttempts";
export const examRouter = createTRPCRouter({
  list: authedProcedure
    .input(schemas.examListInput)
    .query(({ ctx, input }) => exams.listExams(ctx.db, ctx.security, input)),
  get: authedProcedure
    .input(schemas.examIdInput)
    .query(({ ctx, input }) =>
      exams.getExam(ctx.db, ctx.security, input.examId),
    ),
  create: authedProcedure
    .input(schemas.examCreateInput)
    .mutation(({ ctx, input }) => {
      const { projectId, status, ...definition } = input;
      return exams.createExam(ctx.db, ctx.security, {
        projectId,
        status,
        definition,
      });
    }),
  update: authedProcedure
    .input(schemas.examUpdateInput)
    .mutation(({ ctx, input }) => {
      const { examId, expectedRevision, status, ...definition } = input;
      return exams.updateExam(ctx.db, ctx.security, {
        examId,
        expectedRevision,
        status,
        definition,
      });
    }),
  delete: authedProcedure
    .input(schemas.examIdInput)
    .mutation(({ ctx, input }) =>
      exams.deleteExam(ctx.db, ctx.security, input.examId),
    ),
  listAvailable: authedProcedure
    .input(schemas.projectIdInput)
    .query(({ ctx, input }) =>
      exams.listExamsForTrainee(ctx.db, ctx.security, input.projectId),
    ),
  listAttempts: authedProcedure
    .input(schemas.attemptListInput)
    .query(({ ctx, input }) =>
      attempts.listAttempts(ctx.db, ctx.security, {
        ...input,
        projectIds: [input.projectId],
      }),
    ),
  start: authedProcedure
    .input(schemas.examIdInput)
    .mutation(({ ctx, input }) =>
      attempts.startAttempt(ctx.db, ctx.security, input),
    ),
  getAttempt: authedProcedure
    .input(schemas.attemptIdInput)
    .query(({ ctx, input }) =>
      attempts.getOwnAttempt(ctx.db, ctx.security, input.attemptId),
    ),
  getAttemptForReview: authedProcedure
    .input(schemas.attemptIdInput)
    .query(({ ctx, input }) =>
      attempts.getAttemptForReview(ctx.db, ctx.security, input.attemptId),
    ),
  deleteAttempt: authedProcedure
    .input(schemas.attemptIdInput)
    .mutation(({ ctx, input }) =>
      attempts.deleteAttempt(ctx.db, ctx.security, input.attemptId),
    ),
  saveAnswer: authedProcedure
    .input(schemas.saveAnswerInput)
    .mutation(({ ctx, input }) => {
      const { attemptId, ...answer } = input;
      return attempts.saveAnswer(ctx.db, ctx.security, { attemptId, answer });
    }),
  submit: authedProcedure
    .input(schemas.attemptIdInput)
    .mutation(({ ctx, input }) =>
      attempts.submitAttempt(ctx.db, ctx.security, input),
    ),
  grade: authedProcedure
    .input(schemas.examGradeInput)
    .mutation(({ ctx, input }) =>
      attempts.gradeAttempt(ctx.db, ctx.security, input),
    ),
});
