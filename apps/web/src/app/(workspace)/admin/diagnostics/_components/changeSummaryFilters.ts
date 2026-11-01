export const CHANGE_SUMMARY_STATUSES = [
  "pending",
  "ready",
  "failed",
  "skipped",
] as const;
export type ChangeSummaryStatus = (typeof CHANGE_SUMMARY_STATUSES)[number];
export type ChangeSummaryStatusFilter = ChangeSummaryStatus | "all";
export const CHANGE_SUMMARY_PAGE_SIZE = 25;

export function changeSummaryListInput(
  filters: { status: ChangeSummaryStatusFilter; projectId: string },
  cursor: string | undefined,
) {
  return {
    limit: CHANGE_SUMMARY_PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
    ...(filters.status === "all" ? {} : { status: filters.status }),
    ...(filters.projectId === "all" ? {} : { projectId: filters.projectId }),
  };
}

export function changeSummaryEventsHref(row: {
  documentId: string;
  lastJobId: string | null;
}): string {
  const params = new URLSearchParams({ documentId: row.documentId });
  if (row.lastJobId) params.set("jobId", row.lastJobId);
  return `/admin/diagnostics?${params.toString()}#events`;
}

export function completionDuration(row: {
  createdAt: Date;
  completedAt: Date | null;
}): string {
  if (!row.completedAt) return "—";
  const ms = Math.max(0, row.completedAt.getTime() - row.createdAt.getTime());
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}
