import { z } from "zod";
import {
  examDefinitionInputSchema,
  examStatusSchema,
} from "@weaver/core/exams/schema";
import { CoreError } from "@weaver/core/errors";
import { defineTool } from "../../contract";
import { propose, summary } from "../proposals";
import { examQuestionCreateInput, examQuestionUpdateInput } from "./shared";
const fields = examDefinitionInputSchema.shape;
export const proposeExamCreateTool = defineTool({
  name: "propose_exam_create",
  description:
    "Trainer: propose a new exam, draft unless the user asked to publish. Weaver assigns question and choice ids. Questions must be self-contained: put referenced code in prompt as fenced Markdown blocks. Applied if auto-approve is on, else awaits review; check status.",
  kind: "propose",
  capability: "content:propose",
  inputSchema: z.object({
    projectId: z.uuid(),
    ...fields,
    questions: z.array(examQuestionCreateInput).max(100),
    status: z.enum(["draft", "published"]).optional(),
    summary,
  }),
  execute: ({ summary: text, projectId, status, ...definition }, ctx) =>
    propose(ctx, { kind: "exam.create", projectId, status, definition }, text),
});
export const proposeExamUpdateTool = defineTool({
  name: "propose_exam_update",
  description:
    "Trainer: propose an exam edit; expectedRevision from get_exam. Send only changed fields. questions replaces the whole list: keep a question by passing its id, omit id for new ones. Applied if auto-approve is on, else awaits review; check status.",
  kind: "propose",
  capability: "content:propose",
  inputSchema: z.object({
    examId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    title: fields.title.optional(),
    instructions: z.string().max(20000).optional(),
    timeLimitMinutes: fields.timeLimitMinutes.optional(),
    passingPercent: fields.passingPercent,
    questions: z.array(examQuestionUpdateInput).max(100).optional(),
    status: examStatusSchema.optional(),
    summary,
  }),
  async execute(
    { summary: text, examId, expectedRevision, status, ...definition },
    ctx,
  ) {
    const exam = await ctx.db.exam.findUnique({
      where: { id: examId },
      select: { projectId: true },
    });
    if (!exam) throw new CoreError("NOT_FOUND");
    return propose(
      ctx,
      {
        kind: "exam.update",
        projectId: exam.projectId,
        examId,
        expectedRevision,
        status,
        definition,
      },
      text,
    );
  },
});
export const EXAM_PROPOSE_TOOLS = [
  proposeExamCreateTool,
  proposeExamUpdateTool,
] as const;
