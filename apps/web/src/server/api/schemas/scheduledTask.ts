import { externalInputSchema } from "@weaver/core/externalMcp/schema";
import { z } from "zod";
import { scopeRequestSchema } from "@weaver/core/assistant/scopeSchema";
import {
  TASK_INSTRUCTION_MAX_LENGTH,
  TASK_NAME_MAX_LENGTH,
  taskScheduleSchema,
} from "@weaver/core/scheduledTasks/scheduleSchema";

export const taskIdInput = z.object({ taskId: z.uuid() });
export const taskProjectInput = z.object({ projectId: z.uuid() });

const definition = {
  name: z.string().trim().min(1).max(TASK_NAME_MAX_LENGTH),
  instruction: z.string().trim().min(1).max(TASK_INSTRUCTION_MAX_LENGTH),
  scope: scopeRequestSchema,
  outputProjectId: z.uuid(),
  outputFolderPath: z.array(z.string().min(1).max(80)).max(10),
  outputDocumentId: z.uuid().nullable().optional(),
  outputTitle: z.string().trim().max(200).nullable().optional(),
  outputMode: z.enum(["replace", "update"]).optional(),
  schedule: taskScheduleSchema,
  timezone: z.string().min(1).max(64),
};

export const createTaskInput = z.object({
  ...definition,
  externalInputs: externalInputSchema,
});
export const updateTaskInput = z.object({
  taskId: z.uuid(),
  ...definition,
  externalInputs: externalInputSchema.removeDefault().optional(),
});
export const listTaskRunsInput = z.object({
  taskId: z.uuid(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const taskByOutputDocumentInput = z.object({
  projectId: z.uuid(),
  documentId: z.uuid(),
});
