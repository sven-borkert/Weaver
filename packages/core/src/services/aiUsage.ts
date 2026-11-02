import type { AiUsageOutcome, Prisma, PrismaClient } from "@weaver/db/client";
import type { AiUsageSample } from "../ai/types";
import { isPostgresInteger } from "../ai/validation";

type Db = PrismaClient | Prisma.TransactionClient;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

export type AiUsagePricing = {
  inputCostMicrosPerMillion: number | null;
  outputCostMicrosPerMillion: number | null;
};

export type RecordAiUsageInput = {
  id?: string;
  projectId?: string | null;
  operation: string;
  jobId?: string | null;
  runId?: string | null;
  documentId?: string | null;
  /** The commit an enrichment call indexed; a wiki run's indexing cost joins on it. */
  sourceCommitSha?: string | null;
  connectionId?: string | null;
  provider: string;
  model: string;
  configFingerprint: string;
  usage: AiUsageSample;
  outcome: AiUsageOutcome;
  pricing: AiUsagePricing;
  currency?: string | null;
};

export function calculateCostMicros(
  usage: Pick<AiUsageSample, "inputTokens" | "outputTokens">,
  pricing: AiUsagePricing,
): bigint | null {
  const values = [
    usage.inputTokens,
    usage.outputTokens,
    pricing.inputCostMicrosPerMillion,
    pricing.outputCostMicrosPerMillion,
  ];
  if (
    !values.every(
      (value) =>
        value === null ||
        (typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= 0),
    )
  ) {
    throw new RangeError(
      "AI usage counts and prices must be safe nonnegative integers",
    );
  }
  if (usage.inputTokens === null || usage.outputTokens === null) return null;
  if (
    (usage.inputTokens > 0 && pricing.inputCostMicrosPerMillion === null) ||
    (usage.outputTokens > 0 && pricing.outputCostMicrosPerMillion === null)
  )
    return null;

  const numerator =
    BigInt(usage.inputTokens) * BigInt(pricing.inputCostMicrosPerMillion ?? 0) +
    BigInt(usage.outputTokens) *
      BigInt(pricing.outputCostMicrosPerMillion ?? 0);
  return (numerator + 500_000n) / 1_000_000n;
}

export async function recordAiUsage(db: Db, input: RecordAiUsageInput) {
  assertPersistableUsage(input.usage);
  const costMicros = calculateCostMicros(input.usage, input.pricing);
  if (costMicros !== null && costMicros > POSTGRES_BIGINT_MAX) {
    throw new RangeError("AI usage exceeds database limits");
  }
  const data = {
    projectId: input.projectId ?? null,
    operation: input.operation,
    jobId: input.jobId ?? null,
    runId: input.runId ?? null,
    documentId: input.documentId ?? null,
    sourceCommitSha: input.sourceCommitSha ?? null,
    connectionId: input.connectionId ?? null,
    provider: input.provider,
    model: input.model,
    configFingerprint: input.configFingerprint,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cachedTokens: input.usage.cachedTokens,
    totalTokens: input.usage.totalTokens,
    durationMs: input.usage.durationMs,
    outcome: input.outcome,
    costMicros,
    currency: costMicros === null ? null : (input.currency ?? null),
  };
  return input.id
    ? db.aiUsage.upsert({
        where: { id: input.id },
        create: { id: input.id, ...data },
        update: data,
      })
    : db.aiUsage.create({ data });
}

function assertPersistableUsage(usage: AiUsageSample): void {
  const counts = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedTokens,
    usage.totalTokens,
  ];
  if (
    counts.some((count) => count !== null && !isPostgresInteger(count)) ||
    !isPostgresInteger(usage.durationMs)
  ) {
    throw new RangeError("AI usage exceeds database limits");
  }
}
