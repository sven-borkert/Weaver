import type {
  BatchSummary,
  DerivedBatchStatus,
} from "@weaver/core/services/ingestion";

export const BATCH_STATUS_LABELS: Record<DerivedBatchStatus, string> = {
  empty: "Empty",
  pending: "Queued",
  processing: "Processing",
  ready: "Ready for review",
  attention: "Needs attention",
  resolved: "Resolved",
};
export function isIngestionAccessError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("data" in error)) return false;
  const data = error.data;
  return (
    !!data &&
    typeof data === "object" &&
    "code" in data &&
    typeof data.code === "string" &&
    ["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"].includes(data.code)
  );
}
export function ingestionPollingInterval(
  batches?: Pick<BatchSummary, "hasActiveFiles">[],
): 2000 | false {
  return batches?.some((batch) => batch.hasActiveFiles) ? 2000 : false;
}
