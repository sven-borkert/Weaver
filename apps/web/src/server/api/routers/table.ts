import {
  createTableInput,
  deleteTableInput,
  importCsvTableInput,
  listTablesInput,
  moveTableInput,
  rebuildTableIndexInput,
  restoreTableInput,
  saveTableInput,
  tableDiffInput,
  tableHistoryInput,
  tableIdInput,
} from "~/server/api/schemas/table";
import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";
import * as tables from "@weaver/core/services/tables";
import { importCsvTable } from "@weaver/core/services/tableImport";
import { actorOf } from "~/server/api/actor";

export const tableRouter = createTRPCRouter({
  list: authedProcedure
    .input(listTablesInput)
    .query(({ ctx, input }) => tables.listTables(ctx.db, input, actorOf(ctx))),
  get: authedProcedure
    .input(tableIdInput)
    .query(({ ctx, input }) => tables.getTable(ctx.db, input, actorOf(ctx))),
  backlinks: authedProcedure
    .input(tableIdInput)
    .query(({ ctx, input }) =>
      tables.getTableBacklinks(ctx.db, input, actorOf(ctx)),
    ),
  history: authedProcedure
    .input(tableHistoryInput)
    .query(({ ctx, input }) =>
      tables.getTableHistory(ctx.db, input, actorOf(ctx)),
    ),
  diff: authedProcedure
    .input(tableDiffInput)
    .query(({ ctx, input }) =>
      tables.getTableDiff(ctx.db, input, actorOf(ctx)),
    ),
  create: authedProcedure
    .input(createTableInput)
    .mutation(({ ctx, input }) =>
      tables.createTable(ctx.db, input, actorOf(ctx)),
    ),
  importCsv: authedProcedure
    .input(importCsvTableInput)
    .mutation(({ ctx, input }) => importCsvTable(ctx.db, input, actorOf(ctx))),
  save: authedProcedure
    .input(saveTableInput)
    .mutation(({ ctx, input }) =>
      tables.saveTable(ctx.db, input, actorOf(ctx)),
    ),
  move: authedProcedure
    .input(moveTableInput)
    .mutation(({ ctx, input }) =>
      tables.moveTable(ctx.db, input, actorOf(ctx)),
    ),
  delete: authedProcedure
    .input(deleteTableInput)
    .mutation(({ ctx, input }) =>
      tables.deleteTable(ctx.db, input, actorOf(ctx)),
    ),
  restore: authedProcedure
    .input(restoreTableInput)
    .mutation(({ ctx, input }) =>
      tables.restoreTable(ctx.db, input, actorOf(ctx)),
    ),
  rebuildIndex: authedProcedure
    .input(rebuildTableIndexInput)
    .mutation(({ ctx, input }) =>
      tables.rebuildTableIndex(ctx.db, input, actorOf(ctx)),
    ),
});
