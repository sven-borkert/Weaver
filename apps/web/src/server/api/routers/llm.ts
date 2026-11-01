import { adminProcedure, createTRPCRouter } from "~/server/api/trpc";
import {
  connectionIdInput,
  createLlmConnectionInput,
  createLlmModelInput,
  importLlmModelsInput,
  listOpenRouterUpstreamProvidersInput,
  modelIdInput,
  detectEmbeddingDimensionsInput,
  previewKnowledgeModelChangeInput,
  previewKnowledgeRouteChangeInput,
  setLlmRouteInput,
  updateLlmConnectionInput,
  updateLlmModelInput,
  verifyEmbeddingCompatibilityInput,
} from "~/server/api/schemas/llm";
import {
  createLlmConnection,
  createLlmModel,
  deleteLlmConnection,
  detectEmbeddingDimensions,
  deleteLlmModel,
  importLlmModels,
  listLlmConnections,
  listOpenRouterUpstreamProviders,
  testLlmConnection,
  testLlmModel,
  updateLlmConnection,
  updateLlmModel,
} from "@weaver/core/services/llmConnections";
import { listLlmRoutes, setLlmRoute } from "@weaver/core/services/llmRoutes";
import {
  clearEmbeddingCompatibility,
  previewClearEmbeddingCompatibility,
  previewKnowledgeModelChange,
  previewKnowledgeRouteChange,
  verifyEmbeddingCompatibility,
} from "@weaver/core/services/llmVectorSpace";
import type { EncryptionKeyRing } from "@weaver/core/security/encryption";

const deps = (ctx: {
  encryptionKeys: EncryptionKeyRing | null;
  llmFetch: typeof fetch;
}) => ({
  ring: ctx.encryptionKeys,
  fetchImpl: ctx.llmFetch,
});

export const llmRouter = createTRPCRouter({
  overview: adminProcedure.query(async ({ ctx }) => ({
    encryptionConfigured: ctx.encryptionKeys !== null,
    connections: await listLlmConnections(ctx.db, ctx.security),
    routes: await listLlmRoutes(ctx.db, ctx.security),
  })),
  listOpenRouterUpstreamProviders: adminProcedure
    .input(listOpenRouterUpstreamProvidersInput)
    .query(({ ctx, input }) =>
      listOpenRouterUpstreamProviders(ctx.db, ctx.security, deps(ctx), input),
    ),
  setRoute: adminProcedure
    .input(setLlmRouteInput)
    .mutation(({ ctx, input }) =>
      setLlmRoute(ctx.db, ctx.security, input, deps(ctx)),
    ),
  createConnection: adminProcedure
    .input(createLlmConnectionInput)
    .mutation(({ ctx, input }) =>
      createLlmConnection(ctx.db, ctx.security, deps(ctx), input),
    ),
  updateConnection: adminProcedure
    .input(updateLlmConnectionInput)
    .mutation(({ ctx, input }) =>
      updateLlmConnection(ctx.db, ctx.security, deps(ctx), input),
    ),
  deleteConnection: adminProcedure
    .input(connectionIdInput)
    .mutation(({ ctx, input }) =>
      deleteLlmConnection(ctx.db, ctx.security, input.connectionId),
    ),
  testConnection: adminProcedure
    .input(connectionIdInput)
    .mutation(({ ctx, input }) =>
      testLlmConnection(ctx.db, ctx.security, deps(ctx), input.connectionId),
    ),
  createModel: adminProcedure
    .input(createLlmModelInput)
    .mutation(({ ctx, input }) => createLlmModel(ctx.db, ctx.security, input)),
  updateModel: adminProcedure
    .input(updateLlmModelInput)
    .mutation(({ ctx, input }) =>
      updateLlmModel(ctx.db, ctx.security, input, deps(ctx)),
    ),
  importModels: adminProcedure
    .input(importLlmModelsInput)
    .mutation(({ ctx, input }) =>
      importLlmModels(ctx.db, ctx.security, deps(ctx), input),
    ),
  deleteModel: adminProcedure
    .input(modelIdInput)
    .mutation(({ ctx, input }) =>
      deleteLlmModel(ctx.db, ctx.security, input.modelId),
    ),
  testModel: adminProcedure
    .input(modelIdInput)
    .mutation(({ ctx, input }) =>
      testLlmModel(ctx.db, ctx.security, deps(ctx), input.modelId),
    ),
  detectEmbeddingDimensions: adminProcedure
    .input(detectEmbeddingDimensionsInput)
    .mutation(({ ctx, input }) =>
      detectEmbeddingDimensions(ctx.db, ctx.security, deps(ctx), input),
    ),
  verifyEmbeddingCompatibility: adminProcedure
    .input(verifyEmbeddingCompatibilityInput)
    .mutation(({ ctx, input }) =>
      verifyEmbeddingCompatibility(ctx.db, ctx.security, deps(ctx), input),
    ),
  clearEmbeddingCompatibility: adminProcedure
    .input(modelIdInput)
    .mutation(({ ctx, input }) =>
      clearEmbeddingCompatibility(ctx.db, ctx.security, input),
    ),
  previewClearEmbeddingCompatibility: adminProcedure
    .input(modelIdInput)
    .query(({ ctx, input }) =>
      previewClearEmbeddingCompatibility(ctx.db, ctx.security, input),
    ),
  previewKnowledgeRouteChange: adminProcedure
    .input(previewKnowledgeRouteChangeInput)
    .query(({ ctx, input }) =>
      previewKnowledgeRouteChange(ctx.db, ctx.security, input),
    ),
  previewKnowledgeModelChange: adminProcedure
    .input(previewKnowledgeModelChangeInput)
    .query(({ ctx, input }) =>
      previewKnowledgeModelChange(ctx.db, ctx.security, input),
    ),
});
