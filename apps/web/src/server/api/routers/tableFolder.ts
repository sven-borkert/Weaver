import { createTRPCRouter, authedProcedure } from "~/server/api/trpc";
import {
  createFolderInput,
  deleteFolderInput,
  folderTreeInput,
  moveFolderInput,
  renameFolderInput,
} from "~/server/api/schemas/folder";
import * as tableFolders from "@weaver/core/services/tableFolders";
import { actorOf } from "~/server/api/actor";

export const tableFolderRouter = createTRPCRouter({
  tree: authedProcedure
    .input(folderTreeInput)
    .query(({ ctx, input }) =>
      tableFolders.getTree(ctx.db, input, actorOf(ctx)),
    ),
  create: authedProcedure
    .input(createFolderInput)
    .mutation(({ ctx, input }) =>
      tableFolders.createFolder(ctx.db, input, actorOf(ctx)),
    ),
  rename: authedProcedure
    .input(renameFolderInput)
    .mutation(({ ctx, input }) =>
      tableFolders.renameFolder(ctx.db, input, actorOf(ctx)),
    ),
  move: authedProcedure
    .input(moveFolderInput)
    .mutation(({ ctx, input }) =>
      tableFolders.moveFolder(ctx.db, input, actorOf(ctx)),
    ),
  delete: authedProcedure
    .input(deleteFolderInput)
    .mutation(({ ctx, input }) =>
      tableFolders.deleteFolder(ctx.db, input, actorOf(ctx)),
    ),
});
