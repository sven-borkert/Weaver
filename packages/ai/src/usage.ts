import type { AiUsageSample } from "@weaver/core/ai/types";
import { isPostgresInteger } from "@weaver/core/ai/validation";

/** Core rejects anything that is not a Postgres int4 when the sample is persisted
 * (assertPersistableUsage throws RangeError), so an unusable count becomes "unknown" here rather
 * than a poison value that would fail an otherwise-successful run at the accounting step. */
function finite(value: unknown): number | null {
  return isPostgresInteger(value) ? value : null;
}

/** Only ever reads `value[key]` — never the value itself, so a flat count cannot be mistaken for
 * one of its own sub-counts. */
function nested(value: unknown, key: string): number | null {
  return value && typeof value === "object"
    ? finite((value as Record<string, unknown>)[key])
    : null;
}

function count(value: unknown, key: string): number | null {
  return finite(value) ?? nested(value, key);
}

/** Tolerates the ai@7 `LanguageModelUsage` shape (flat counts plus `inputTokenDetails`) as well as
 * the flat v5 and nested `{ total }` shapes, so a minor SDK bump cannot zero the accounting. */
export function usageFromSdk(
  usage: unknown,
  durationMs: number,
): AiUsageSample {
  const record =
    usage && typeof usage === "object"
      ? (usage as Record<string, unknown>)
      : {};
  const inputTokens = count(record.inputTokens, "total");
  const outputTokens = count(record.outputTokens, "total");
  const cachedTokens =
    nested(record.inputTokenDetails, "cacheReadTokens") ??
    count(record.cachedInputTokens, "total") ??
    nested(record.inputTokens, "cacheRead");
  const totalTokens =
    count(record.totalTokens, "total") ??
    (inputTokens !== null && outputTokens !== null
      ? finite(inputTokens + outputTokens)
      : null);
  return { inputTokens, outputTokens, cachedTokens, totalTokens, durationMs };
}

export function accumulateUsage(
  previous: AiUsageSample | null,
  next: AiUsageSample,
): AiUsageSample {
  if (!previous) return next;
  const sum = (a: number | null, b: number | null) =>
    a === null ? b : b === null ? a : finite(a + b);
  return {
    inputTokens: sum(previous.inputTokens, next.inputTokens),
    outputTokens: sum(previous.outputTokens, next.outputTokens),
    cachedTokens: sum(previous.cachedTokens, next.cachedTokens),
    totalTokens: sum(previous.totalTokens, next.totalTokens),
    durationMs: next.durationMs,
  };
}

export function usageFromError(
  error: unknown,
  durationMs: number,
): AiUsageSample | null {
  for (
    let depth = 0;
    depth < 5 && error && typeof error === "object";
    depth++
  ) {
    const record = error as Record<string, unknown>;
    const usage = usageFromSdk(record.usage, durationMs);
    if (
      usage.inputTokens !== null ||
      usage.outputTokens !== null ||
      usage.totalTokens !== null
    )
      return usage;
    error = record.cause ?? record.lastError;
  }
  return null;
}
