import { createHash } from "node:crypto";

import type { LlmEmbeddingDimensionMode } from "@weaver/db/client";

export type VectorSpaceModel = {
  providerType: string;
  endpoint: string;
  providerModelId: string;
  upstreamProvider?: string | null;
  vectorSpaceKey?: string | null;
};

export type ExtractionModelIdentity = {
  providerType: string;
  endpoint: string;
  providerModelId: string;
  upstreamProvider?: string | null;
};

export type IndexVectorSpace = {
  vectorSpaceKey: string;
  embeddingDimensions: number;
  embeddingDimensionMode: LlmEmbeddingDimensionMode;
};

// Must match weaver_knowledge_field() in migration 20260926090000_knowledge_index_identity.
export function knowledgeIdentityField(
  value: string | null | undefined,
): string {
  return (value ?? "").replaceAll("\\", "\\\\").replaceAll("|", "\\|");
}

function digest(
  literals: string[],
  fields: Array<string | null | undefined>,
): string {
  return createHash("sha256")
    .update(
      [...literals, ...fields.map(knowledgeIdentityField)].join("|"),
      "utf8",
    )
    .digest("hex");
}

export function defaultVectorSpaceKey(model: VectorSpaceModel): string {
  return digest(
    ["weaver-vector-space-v1"],
    [
      model.providerType,
      model.endpoint,
      model.providerModelId,
      model.upstreamProvider,
    ],
  );
}

export function effectiveVectorSpaceKey(model: VectorSpaceModel): string {
  return model.vectorSpaceKey ?? defaultVectorSpaceKey(model);
}

export function knowledgeIndexFingerprint(
  space: IndexVectorSpace | null,
  extractionSchemaVersion: number,
): string {
  if (!space) {
    return digest(
      ["weaver-index-v2", "keyword-only"],
      [String(extractionSchemaVersion)],
    );
  }
  return digest(
    ["weaver-index-v2", "ai"],
    [
      space.vectorSpaceKey,
      String(space.embeddingDimensions),
      space.embeddingDimensionMode,
      String(extractionSchemaVersion),
    ],
  );
}

export function knowledgeExtractionFingerprint(
  model: ExtractionModelIdentity,
  promptVersion: string,
): string {
  return digest(
    ["weaver-extraction-v1"],
    [
      model.providerType,
      model.endpoint,
      model.providerModelId,
      model.upstreamProvider,
      promptVersion,
    ],
  );
}
