import {
  createTaskInput,
  listTaskRunsInput,
  taskByOutputDocumentInput,
  taskIdInput,
  taskProjectInput,
  updateTaskInput,
} from "~/server/api/schemas/scheduledTask";
import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";
import {
  createTask,
  deleteTask,
  getTask,
  listOwnedTasks,
  listProjectTasks,
  listTaskRuns,
  pauseTask,
  resumeTask,
  runTaskNow,
  taskForOutputDocument,
  updateTask,
} from "@weaver/core/services/scheduledTasks";

export const scheduledTaskRouter = createTRPCRouter({
  listForProject: authedProcedure
    .input(taskProjectInput)
    .query(({ ctx, input }) =>
      listProjectTasks(ctx.db, ctx.security, input.projectId),
    ),
  listMine: authedProcedure.query(({ ctx }) =>
    listOwnedTasks(ctx.db, ctx.security),
  ),
  get: authedProcedure
    .input(taskIdInput)
    .query(({ ctx, input }) => getTask(ctx.db, ctx.security, input.taskId)),
  listRuns: authedProcedure
    .input(listTaskRunsInput)
    .query(({ ctx, input }) => listTaskRuns(ctx.db, ctx.security, input)),
  byOutputDocument: authedProcedure
    .input(taskByOutputDocumentInput)
    .query(({ ctx, input }) =>
      taskForOutputDocument(ctx.db, ctx.security, input),
    ),
  create: authedProcedure
    .input(createTaskInput)
    .mutation(({ ctx, input }) => createTask(ctx.db, ctx.security, input)),
  update: authedProcedure
    .input(updateTaskInput)
    .mutation(({ ctx, input }) => updateTask(ctx.db, ctx.security, input)),
  delete: authedProcedure
    .input(taskIdInput)
    .mutation(({ ctx, input }) =>
      deleteTask(ctx.db, ctx.security, input.taskId),
    ),
  pause: authedProcedure
    .input(taskIdInput)
    .mutation(({ ctx, input }) =>
      pauseTask(ctx.db, ctx.security, input.taskId),
    ),
  resume: authedProcedure
    .input(taskIdInput)
    .mutation(({ ctx, input }) =>
      resumeTask(ctx.db, ctx.security, input.taskId),
    ),
  runNow: authedProcedure
    .input(taskIdInput)
    .mutation(({ ctx, input }) =>
      runTaskNow(ctx.db, ctx.security, input.taskId),
    ),
});
