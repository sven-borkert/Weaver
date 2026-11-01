export const MAX_LLM_NAME_LENGTH = 80;
export const MAX_PROVIDER_MODEL_ID_LENGTH = 200;
export const POSTGRES_INTEGER_MAX = 2_147_483_647;
export const MAX_EMBEDDING_DIMENSIONS = 16_000;

/** `expectedDimensions: null` accepts any length in 1..MAX_EMBEDDING_DIMENSIONS (dimension probes). */
export function isValidEmbeddingVector(
  vector: unknown,
  expectedDimensions: number | null,
): vector is number[] {
  if (!Array.isArray(vector)) return false;
  if (expectedDimensions === null) {
    if (vector.length < 1 || vector.length > MAX_EMBEDDING_DIMENSIONS) {
      return false;
    }
  } else if (vector.length !== expectedDimensions) {
    return false;
  }

  let hasNonZeroComponent = false;
  for (const component of vector) {
    if (typeof component !== "number" || !Number.isFinite(component)) {
      return false;
    }
    const float32 = Math.fround(component);
    if (!Number.isFinite(float32)) return false;
    if (float32 !== 0) hasNonZeroComponent = true;
  }
  return hasNonZeroComponent;
}

export function isPostgresInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= POSTGRES_INTEGER_MAX
  );
}
