import {
  beginRemoteConnection,
  createRemoteInstance,
  deleteRemoteInstance,
  disconnectRemoteInstance,
  fetchTransferTargetFolders,
  fetchTransferTargets,
  listRemoteInstances,
  listRemoteInstancesForUser,
  sendDocumentToRemote,
  sendTableToRemote,
  testRemoteInstance,
  updateRemoteInstance,
} from "@weaver/core/services/remoteInstances";
import { remoteRuntime } from "~/server/remoteInstances";
import {
  createRemoteInstanceInput,
  remoteInstanceIdInput,
  remoteInstanceRefInput,
  remoteTargetFoldersInput,
  revisionRemoteInstanceInput,
  sendDocumentInput,
  sendTableInput,
  updateRemoteInstanceInput,
} from "~/server/api/schemas/remoteInstance";
import {
  adminProcedure,
  authedProcedure,
  createTRPCRouter,
} from "~/server/api/trpc";

export const remoteInstanceRouter = createTRPCRouter({
  list: adminProcedure.query(({ ctx }) =>
    listRemoteInstances(ctx.db, ctx.security),
  ),
  create: adminProcedure
    .input(createRemoteInstanceInput)
    .mutation(({ ctx, input }) =>
      createRemoteInstance(remoteRuntime(ctx), ctx.security, input),
    ),
  update: adminProcedure
    .input(updateRemoteInstanceInput)
    .mutation(({ ctx, input }) =>
      updateRemoteInstance(remoteRuntime(ctx), ctx.security, input),
    ),
  delete: adminProcedure
    .input(revisionRemoteInstanceInput)
    .mutation(({ ctx, input }) =>
      deleteRemoteInstance(remoteRuntime(ctx), ctx.security, input),
    ),
  test: adminProcedure
    .input(remoteInstanceIdInput)
    .mutation(({ ctx, input }) =>
      testRemoteInstance(remoteRuntime(ctx), ctx.security, input),
    ),
  listForUser: authedProcedure.query(({ ctx }) =>
    listRemoteInstancesForUser(ctx.db, ctx.security),
  ),
  // Session-only in practice: API-key and OAuth callers never reach tRPC.
  connect: authedProcedure
    .input(remoteInstanceRefInput)
    .mutation(({ ctx, input }) =>
      beginRemoteConnection(remoteRuntime(ctx), ctx.security, input),
    ),
  disconnect: authedProcedure
    .input(remoteInstanceRefInput)
    .mutation(({ ctx, input }) =>
      disconnectRemoteInstance(ctx.db, ctx.security, input),
    ),
  targets: authedProcedure
    .input(remoteInstanceRefInput)
    .query(({ ctx, input }) =>
      fetchTransferTargets(remoteRuntime(ctx), ctx.security, input),
    ),
  targetFolders: authedProcedure
    .input(remoteTargetFoldersInput)
    .query(({ ctx, input }) =>
      fetchTransferTargetFolders(remoteRuntime(ctx), ctx.security, input),
    ),
  sendDocument: authedProcedure
    .input(sendDocumentInput)
    .mutation(({ ctx, input }) =>
      sendDocumentToRemote(remoteRuntime(ctx), ctx.security, input),
    ),
  sendTable: authedProcedure
    .input(sendTableInput)
    .mutation(({ ctx, input }) =>
      sendTableToRemote(remoteRuntime(ctx), ctx.security, input),
    ),
});
