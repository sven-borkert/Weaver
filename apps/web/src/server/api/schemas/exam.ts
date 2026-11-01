import { z } from "zod";
import {
  examDefinitionInputSchema,
  examAnswerInputSchema,
  examStatusSchema,
  attemptListStatusSchema,
  gradeAttemptInputSchema,
} from "@weaver/core/exams/schema";
export const examIdInput = z.object({ examId: z.uuid() });
export const attemptIdInput = z.object({ attemptId: z.uuid() });
export const examListInput = z.object({
  projectId: z.uuid(),
  status: examStatusSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(1000).optional(),
});
export const examCreateInput = examDefinitionInputSchema.safeExtend({
  projectId: z.uuid(),
  status: z.enum(["draft", "published"]).optional(),
});
export const examUpdateInput = z
  .object(examDefinitionInputSchema.shape)
  .partial()
  .extend({
    instructions: z.string().max(20_000).optional(),
    examId: z.uuid(),
    expectedRevision: z.number().int().min(1),
    status: examStatusSchema.optional(),
  });
export const attemptListInput = z.object({
  projectId: z.uuid(),
  examId: z.uuid().optional(),
  status: attemptListStatusSchema.optional(),
  cursor: z.string().max(600).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const examGradeInput = gradeAttemptInputSchema.extend({
  attemptId: z.uuid(),
  expectedRevision: z.number().int().min(1),
});
export const saveAnswerInput = examAnswerInputSchema.extend({
  attemptId: z.uuid(),
});
export const projectIdInput = z.object({ projectId: z.uuid() });
