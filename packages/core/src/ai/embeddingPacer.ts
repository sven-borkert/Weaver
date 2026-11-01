/** Share of the request timeout a paced embedding request is sized to fill. */
export const EMBEDDING_TIMEOUT_TARGET_FRACTION = 0.5;

export type EmbeddingPacer = {
  /** Most input characters the next request should carry (its first input always goes); 0 until measured. */
  characterBudget(): number;
  recordSuccess(characters: number, durationMs: number): void;
  recordTimeout(): void;
};

// Sizes requests from observed throughput so a slow local model stays inside its timeout.
export function createEmbeddingPacer(timeoutMs: number): EmbeddingPacer {
  let charactersPerSecond: number | null = null;
  return {
    characterBudget() {
      if (charactersPerSecond === null) return 0;
      return Math.floor(
        (charactersPerSecond * timeoutMs * EMBEDDING_TIMEOUT_TARGET_FRACTION) /
          1_000,
      );
    },
    recordSuccess(characters, durationMs) {
      if (characters <= 0) return;
      const sample = (characters * 1_000) / Math.max(durationMs, 1);
      charactersPerSecond =
        charactersPerSecond === null
          ? sample
          : (charactersPerSecond + sample) / 2;
    },
    recordTimeout() {
      if (charactersPerSecond !== null) charactersPerSecond /= 2;
    },
  };
}
