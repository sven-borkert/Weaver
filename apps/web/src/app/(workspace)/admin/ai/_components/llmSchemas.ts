import { z } from "zod";

import {
  INDEXED_EMBEDDING_DIMENSIONS,
  isIndexedKnowledgeDimensions,
  isSupportedKnowledgeDimensions,
} from "@weaver/core/knowledge/dimensions";

// Client-side mirror of the server's llm input schemas (apps/web/src/server/api/schemas/llm.ts)
export const providerTypes = [
  "openai",
  "anthropic",
  "openrouter",
  "openai_compatible",
  "lmstudio",
  "ollama",
] as const;
export type ProviderType = (typeof providerTypes)[number];
export const capabilities = [
  "chat",
  "json_output",
  "tool_use",
  "embedding",
  "vision",
] as const;
export const PROVIDER_LABELS = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  openai_compatible: "OpenAI-compatible endpoint",
  lmstudio: "LM Studio",
  ollama: "Ollama",
} as const;
// Mirrors PROVIDER_FIXED_ENDPOINTS / PROVIDER_DEFAULT_ENDPOINTS in packages/core/src/ai/adapters.ts
export const PROVIDER_FIXED_ENDPOINTS = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
} as const;
export const PROVIDER_DEFAULT_ENDPOINTS = {
  lmstudio: "http://127.0.0.1:1234",
  ollama: "http://127.0.0.1:11434",
} as const;
export const reasoningModes = [
  "provider_default",
  "none",
  "low",
  "medium",
  "high",
] as const;
export type ReasoningMode = (typeof reasoningModes)[number];
export const REASONING_MODE_LABELS = {
  provider_default: "Provider default",
  none: "Off (if supported)",
  low: "Low",
  medium: "Medium",
  high: "High",
} as const;
export const CAPABILITY_LABELS = {
  chat: "Chat",
  json_output: "JSON output",
  tool_use: "Tool use",
  embedding: "Embeddings",
  vision: "Vision",
} as const;
export const SOURCE_LABELS = {
  endpoint: "Endpoint",
  catalog: "Catalog",
  inferred: "Inferred",
} as const;
export const PURPOSE_LABELS = {
  assistant: "Assistant",
  knowledge_extraction: "Knowledge extraction",
  knowledge_embedding: "Knowledge embeddings",
  ingestion: "Import parsing",
  jobs: "Scheduled tasks",
  document_summary: "Document change summaries",
  wiki: "Project wiki agent",
} as const;
export const HEALTH_LABELS = {
  ready: "Ready",
  unassigned: "Unassigned",
  connection_disabled: "Connection disabled",
  capability_mismatch: "Missing capability",
  dimensions_mismatch: "Unsupported dimensions",
} as const;

export function fixedEndpointFor(providerType: ProviderType): string | null {
  return providerType === "openai" ||
    providerType === "anthropic" ||
    providerType === "openrouter"
    ? PROVIDER_FIXED_ENDPOINTS[providerType]
    : null;
}

export function providerHasEditableEndpoint(
  providerType: ProviderType,
): boolean {
  return fixedEndpointFor(providerType) === null;
}

export function providerRequiresCredential(
  providerType: ProviderType,
): boolean {
  return providerType !== "lmstudio" && providerType !== "ollama";
}

/** Replaces the endpoint only when it is blank or still one of the prefilled local defaults. */
export function endpointAfterProviderChange(
  current: string,
  next: ProviderType,
): string {
  const trimmed = current.trim();
  const prefilled = new Set<string>(Object.values(PROVIDER_DEFAULT_ENDPOINTS));
  if (trimmed !== "" && !prefilled.has(trimmed)) return current;
  return next === "lmstudio" || next === "ollama"
    ? PROVIDER_DEFAULT_ENDPOINTS[next]
    : "";
}

import { POSTGRES_INTEGER_MAX } from "@weaver/core/ai/validation";

function isIntegerInRange(value: string, minimum: number, maximum: number) {
  if (value === "") return true;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum;
}

const optionalPostgresInteger = z
  .string()
  .trim()
  .refine(
    (value) => isIntegerInRange(value, 0, POSTGRES_INTEGER_MAX),
    "Must be a non-negative integer",
  );

export const connectionFormSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(80),
    providerType: z.enum(providerTypes),
    endpoint: z.string().trim().max(2048),
    credential: z.string().max(4096),
    requestTimeoutMs: z.coerce.number().int().min(1).max(120_000),
    enabled: z.boolean(),
  })
  .superRefine((values, context) => {
    if (
      providerHasEditableEndpoint(values.providerType) &&
      values.endpoint === ""
    ) {
      context.addIssue({
        code: "custom",
        message: "Endpoint is required",
        path: ["endpoint"],
      });
    }
  });
export type ConnectionFormInput = z.input<typeof connectionFormSchema>;
export type ConnectionFormValues = z.infer<typeof connectionFormSchema>;

export const modelFormSchema = z
  .object({
    providerModelId: z.string().trim().min(1, "Model id is required").max(200),
    displayName: z.string().trim().min(1, "Display name is required").max(80),
    contextWindow: optionalPostgresInteger.refine(
      (value) => value === "" || Number(value) >= 1,
      "Must be a positive integer",
    ),
    maxOutputTokens: optionalPostgresInteger.refine(
      (value) => value === "" || Number(value) >= 1,
      "Must be a positive integer",
    ),
    embeddingDimensions: z.string().trim(),
    embeddingDimensionMode: z.enum(["native", "matryoshka"]),
    upstreamProvider: z.string().trim().max(200),
    capabilities: z
      .array(z.enum(capabilities))
      .min(1, "Select at least one capability"),
    inputCostMicrosPerMillion: optionalPostgresInteger,
    outputCostMicrosPerMillion: optionalPostgresInteger,
    currency: z.string().trim().max(8),
  })
  .superRefine((values, context) => {
    if (
      values.capabilities.includes("embedding") &&
      (values.embeddingDimensions === "" ||
        !isIntegerInRange(values.embeddingDimensions, 1, 16_000))
    ) {
      context.addIssue({
        code: "custom",
        message: "Embedding models must declare dimensions from 1 to 16000",
        path: ["embeddingDimensions"],
      });
    }
  });
export type ModelFormValues = z.infer<typeof modelFormSchema>;

export function savedMessage(
  subject: string,
  reindexProjects: number | undefined,
): string {
  if (!reindexProjects) return `${subject} saved`;
  return `${subject} saved. Re-embedding started in ${reindexProjects} project${reindexProjects === 1 ? "" : "s"}.`;
}

const KNOWLEDGE_DIMENSION_HINT = `Knowledge embeddings support 1–4,000; indexed sizes: ${INDEXED_EMBEDDING_DIMENSIONS.map((size) => size.toLocaleString("en-US")).join(", ")}.`;

export function knowledgeDimensionHint(value: string): string {
  let size: number | null;
  try {
    size = optionalInt(value);
  } catch {
    return KNOWLEDGE_DIMENSION_HINT;
  }
  return size !== null &&
    isSupportedKnowledgeDimensions(size) &&
    !isIndexedKnowledgeDimensions(size)
    ? `${KNOWLEDGE_DIMENSION_HINT} This size uses exact search, which is fine for small projects.`
    : KNOWLEDGE_DIMENSION_HINT;
}

type EmbeddingIdentityFields = {
  providerModelId: string;
  embeddingDimensions: number | null;
  embeddingDimensionMode: string;
  upstreamProvider: string | null;
};

export function changesEmbeddingIdentity(
  saved: EmbeddingIdentityFields,
  next: EmbeddingIdentityFields,
): boolean {
  return (
    saved.providerModelId !== next.providerModelId ||
    saved.embeddingDimensions !== next.embeddingDimensions ||
    saved.embeddingDimensionMode !== next.embeddingDimensionMode ||
    saved.upstreamProvider !== next.upstreamProvider
  );
}

export function reembedMessage(projects: number): string {
  return `Re-embeds the knowledge index of ${projects} project${projects === 1 ? "" : "s"}. The graph is kept; semantic search shows keyword results until each project finishes.`;
}

export function optionalInt(value: string): number | null {
  const normalized = value.trim();
  if (normalized === "") return null;
  const parsed = Number(normalized);
  if (
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > POSTGRES_INTEGER_MAX
  ) {
    throw new Error("Value must be a valid PostgreSQL integer");
  }
  return parsed;
}
