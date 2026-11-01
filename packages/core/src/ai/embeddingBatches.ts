import { MAX_AI_PROVIDER_REQUEST_BYTES } from "./http";
import { AiProviderError, type AiProvider } from "./types";

const MAX_EMBEDDING_BATCH_ITEMS = 32;

type BatchProvider = Pick<AiProvider, "embeddingRequestByteLength"> &
  Partial<Pick<AiProvider, "embeddingCharacterBudget">>;

export function makeEmbeddingBatches<T>(
  items: T[],
  provider: BatchProvider,
  text: (item: T) => string,
): Iterable<T[]> {
  const bytes = (batch: T[]) =>
    provider.embeddingRequestByteLength(batch.map(text));
  for (const item of items) {
    if (bytes([item]) > MAX_AI_PROVIDER_REQUEST_BYTES) {
      throw new AiProviderError("Embedding input exceeds batch limits", {
        kind: "validation",
        retryable: false,
      });
    }
  }
  return pacedBatches(items, provider, text, bytes);
}

// Lazy so each batch reads the budget after the previous request was measured.
function* pacedBatches<T>(
  items: T[],
  provider: BatchProvider,
  text: (item: T) => string,
  bytes: (batch: T[]) => number,
): Generator<T[]> {
  let index = 0;
  while (index < items.length) {
    const budget = provider.embeddingCharacterBudget?.() ?? Infinity;
    const batch = [items[index]!];
    let characters = text(items[index]!).length;
    index += 1;
    while (index < items.length && batch.length < MAX_EMBEDDING_BATCH_ITEMS) {
      const next = items[index]!;
      const nextCharacters = characters + text(next).length;
      if (
        nextCharacters > budget ||
        bytes([...batch, next]) > MAX_AI_PROVIDER_REQUEST_BYTES
      ) {
        break;
      }
      batch.push(next);
      characters = nextCharacters;
      index += 1;
    }
    yield batch;
  }
}
