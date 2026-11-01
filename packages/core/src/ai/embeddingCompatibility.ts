export const EMBEDDING_COMPATIBILITY_MIN_SIMILARITY = 0.98;

// Fixed, non-project texts; changing them changes every future verification result.
export const EMBEDDING_COMPATIBILITY_SAMPLES: readonly string[] = [
  "Weaver keeps project documents, tables and a knowledge graph in one place.",
  "Der Wartungsvertrag für die Heizungsanlage verlängert sich automatisch um ein Jahr.",
  "Invoice 2026-114: three network switches with 24 PoE+ ports, delivered to the Berlin office.",
  "Kurze Notiz: Das Backup läuft jede Nacht um 02:40 Uhr.",
  "The PostgreSQL primary replicates to a hot standby; failover is manual and documented in the runbook.",
  "Meeting-Protokoll: Entscheidung für einen Ausweichanbieter, Umsetzung bis Ende Oktober.",
  "- milk\n- eggs\n- coffee beans",
  "Quantized and full-precision copies of one embedding model should produce nearly identical vectors for the same text, while unrelated models place it in entirely different directions of their vector spaces.",
];

export function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length !== right.length || left.length === 0) {
    throw new Error("Embedding vectors differ in length");
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }
  const norm = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new Error("Embedding vector has no direction");
  }
  return dot / norm;
}

export function compareEmbeddingSamples(
  left: readonly number[][],
  right: readonly number[][],
): { minSimilarity: number; meanSimilarity: number; compatible: boolean } {
  const expected = EMBEDDING_COMPATIBILITY_SAMPLES.length;
  if (left.length !== expected || right.length !== expected) {
    throw new Error("Embedding comparison needs one vector per sample");
  }
  const similarities = left.map((vector, index) =>
    cosineSimilarity(vector, right[index]!),
  );
  const minSimilarity = Math.min(...similarities);
  const meanSimilarity =
    similarities.reduce((sum, value) => sum + value, 0) / similarities.length;
  return {
    minSimilarity,
    meanSimilarity,
    compatible: minSimilarity >= EMBEDDING_COMPATIBILITY_MIN_SIMILARITY,
  };
}
