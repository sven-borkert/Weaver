import { VECTOR_INDEX_DIMENSIONS_MAX } from "./dimensions";

export type EmbeddingDimensionMode = "native" | "matryoshka";

export type GenerationEmbedding = {
  /** Null when the caller may not see model names. */
  model: string | null;
  dimensions: number;
  /** Null for a generation without a readable route snapshot. */
  dimensionMode: EmbeddingDimensionMode | null;
  vectorType: "vector" | "halfvec";
};

export function embeddingVectorKind(
  dimensions: number,
): GenerationEmbedding["vectorType"] {
  return dimensions <= VECTOR_INDEX_DIMENSIONS_MAX ? "vector" : "halfvec";
}

export function generationEmbedding(
  generation: {
    embeddingModel: string;
    embeddingDimensions: number;
    routeSnapshot: unknown;
  },
  options: { includeModel: boolean },
): GenerationEmbedding {
  return {
    model: options.includeModel ? generation.embeddingModel : null,
    dimensions: generation.embeddingDimensions,
    dimensionMode: snapshotDimensionMode(generation.routeSnapshot),
    vectorType: embeddingVectorKind(generation.embeddingDimensions),
  };
}

export function describeGenerationEmbedding(
  embedding: GenerationEmbedding,
): string {
  const dimensions = `${embedding.dimensions.toLocaleString("en-US")} dimension${embedding.dimensions === 1 ? "" : "s"}`;
  const mode =
    embedding.dimensionMode === "matryoshka"
      ? "Matryoshka"
      : embedding.dimensionMode === "native"
        ? "Native"
        : null;
  return [embedding.model, dimensions, mode, embedding.vectorType]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

function snapshotDimensionMode(
  snapshot: unknown,
): EmbeddingDimensionMode | null {
  if (!isRecord(snapshot) || !isRecord(snapshot.embedding)) return null;
  const mode = snapshot.embedding.embeddingDimensionMode;
  return mode === "native" || mode === "matryoshka" ? mode : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
