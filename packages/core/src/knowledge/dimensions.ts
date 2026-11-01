/** pgvector's HNSW index handles up to 2,000 dimensions for `vector` and 4,000 for `halfvec`. */
export const KNOWLEDGE_EMBEDDING_DIMENSIONS_MAX = 4000;
export const VECTOR_INDEX_DIMENSIONS_MAX = 2000;
export const INDEXED_EMBEDDING_DIMENSIONS = [
  256, 384, 512, 768, 1024, 1536, 2048, 2560, 3072, 4000,
] as const;
export const KNOWLEDGE_DIMENSIONS_MESSAGE =
  "Knowledge embeddings need 1–4,000 dimensions";

export function isSupportedKnowledgeDimensions(
  value: number | null | undefined,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= KNOWLEDGE_EMBEDDING_DIMENSIONS_MAX
  );
}

export function isIndexedKnowledgeDimensions(value: number): boolean {
  return (INDEXED_EMBEDDING_DIMENSIONS as readonly number[]).includes(value);
}
