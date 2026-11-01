import {
  MAX_LLM_NAME_LENGTH,
  MAX_EMBEDDING_DIMENSIONS,
  MAX_PROVIDER_MODEL_ID_LENGTH,
} from "../ai/validation";
import { z } from "zod";

export const llmProviderTypes = [
  "openai",
  "anthropic",
  "openrouter",
  "openai_compatible",
  "lmstudio",
  "ollama",
] as const;
export const llmModelCapabilities = [
  "chat",
  "json_output",
  "tool_use",
  "embedding",
  "vision",
] as const;
export const llmEmbeddingDimensionModes = ["native", "matryoshka"] as const;
export const llmReasoningModes = [
  "provider_default",
  "none",
  "low",
  "medium",
  "high",
] as const;
export const activeLlmPurposes = [
  "assistant",
  "knowledge_extraction",
  "knowledge_embedding",
  "ingestion",
  "jobs",
  "document_summary",
] as const;

export const connectionIdInput = z.object({ connectionId: z.uuid() });
export const modelIdInput = z.object({ modelId: z.uuid() });
export const listOpenRouterUpstreamProvidersInput = z.object({
  connectionId: z.uuid(),
  providerModelId: z.string().trim().min(1).max(MAX_PROVIDER_MODEL_ID_LENGTH),
});

export const createLlmConnectionInput = z.object({
  name: z.string().trim().min(1).max(MAX_LLM_NAME_LENGTH),
  providerType: z.enum(llmProviderTypes),
  endpoint: z.string().trim().max(2048).nullish(),
  // The service decides per provider whether an empty credential is allowed.
  credential: z
    .string()
    .max(4096)
    .regex(
      /^[\x20-\x7e]*$/,
      "Credential must contain printable ASCII characters",
    ),
  requestTimeoutMs: z.number().int().min(1).max(120_000).optional(),
  enabled: z.boolean().optional(),
});

export const updateLlmConnectionInput = z.object({
  connectionId: z.uuid(),
  name: z.string().trim().min(1).max(MAX_LLM_NAME_LENGTH).optional(),
  endpoint: z.string().trim().max(2048).nullish(),
  credential: z
    .string()
    .max(4096)
    .regex(
      /^[\x20-\x7e]*$/,
      "Credential must contain printable ASCII characters",
    )
    .nullish(),
  requestTimeoutMs: z.number().int().min(1).max(120_000).optional(),
  enabled: z.boolean().optional(),
});

const modelFields = {
  providerModelId: z.string().trim().min(1).max(MAX_PROVIDER_MODEL_ID_LENGTH),
  displayName: z.string().trim().min(1).max(MAX_LLM_NAME_LENGTH),
  contextWindow: z.number().int().min(1).max(2_147_483_647).nullish(),
  maxOutputTokens: z.number().int().min(1).max(2_147_483_647).nullish(),
  embeddingDimensions: z
    .number()
    .int()
    .min(1)
    .max(MAX_EMBEDDING_DIMENSIONS)
    .nullish(),
  embeddingDimensionMode: z.enum(llmEmbeddingDimensionModes).optional(),
  upstreamProvider: z.string().trim().min(1).max(200).nullish(),
  capabilities: z.array(z.enum(llmModelCapabilities)).min(1),
  inputCostMicrosPerMillion: z
    .number()
    .int()
    .min(0)
    .max(2_147_483_647)
    .nullish(),
  outputCostMicrosPerMillion: z
    .number()
    .int()
    .min(0)
    .max(2_147_483_647)
    .nullish(),
  currency: z.string().trim().max(8).nullish(),
};
export const createLlmModelInput = z.object({
  connectionId: z.uuid(),
  ...modelFields,
});
export const updateLlmModelInput = z.object({ modelId: z.uuid() }).extend(
  Object.fromEntries(
    Object.entries(modelFields).map(([key, schema]) => [
      key,
      schema.optional(),
    ]),
  ) as {
    [K in keyof typeof modelFields]: z.ZodOptional<(typeof modelFields)[K]>;
  },
);
export const importLlmModelsInput = z.object({
  connectionId: z.uuid(),
  updateExisting: z.boolean(),
  models: z
    .array(
      z.object({
        providerModelId: modelFields.providerModelId,
        displayName: modelFields.displayName,
        capabilities: modelFields.capabilities,
        contextWindow: modelFields.contextWindow,
        maxOutputTokens: modelFields.maxOutputTokens,
        embeddingDimensions: modelFields.embeddingDimensions,
      }),
    )
    .min(1)
    .max(500),
});
export const setLlmRouteInput = z.object({
  purpose: z.enum(activeLlmPurposes),
  modelId: z.uuid().nullable(),
  reasoningMode: z.enum(llmReasoningModes).optional(),
});

export const verifyEmbeddingCompatibilityInput = z.object({
  modelId: z.uuid(),
  referenceModelId: z.uuid(),
});
export const setEmbeddingCompatibilityInput = z.object({
  modelId: z.uuid(),
  referenceModelId: z.uuid().nullable(),
});
export const previewKnowledgeRouteChangeInput = z.object({
  purpose: z.enum(["knowledge_extraction", "knowledge_embedding"]),
  modelId: z.uuid(),
});
export const previewKnowledgeModelChangeInput = z.object({
  modelId: z.uuid(),
  providerModelId: modelFields.providerModelId.optional(),
  embeddingDimensions: modelFields.embeddingDimensions,
  embeddingDimensionMode: modelFields.embeddingDimensionMode,
  upstreamProvider: modelFields.upstreamProvider,
});
export const detectEmbeddingDimensionsInput = z.object({
  connectionId: z.uuid(),
  providerModelId: modelFields.providerModelId,
  upstreamProvider: modelFields.upstreamProvider,
});
