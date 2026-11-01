import Link from "next/link";
import type { FileSummary } from "@weaver/core/services/ingestion";

type Status = FileSummary["status"];
const LABELS: Record<Status, string> = {
  pending: "Queued",
  parsing: "Parsing",
  extracting: "Extracting",
  linking: "Linking",
  ready: "Ready for review",
  accepting: "Accepting",
  accepted: "Accepted",
  rejected: "Rejected",
  failed: "Failed",
  blocked_configuration: "Needs configuration",
};
const TONES: Record<Status, string> = {
  pending: "bg-surface-2 text-text-2",
  parsing: "bg-info-bg text-info",
  extracting: "bg-info-bg text-info",
  linking: "bg-info-bg text-info",
  ready: "bg-review-bg text-review",
  accepting: "bg-info-bg text-info",
  accepted: "bg-approved-bg text-approved",
  rejected: "bg-surface-2 text-text-3",
  failed: "bg-danger-bg text-danger",
  blocked_configuration: "bg-review-bg text-review",
};
export function FileStageBadge({
  status,
  failureMessage,
}: {
  status: Status;
  failureMessage?: string | null;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span
        className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONES[status]}`}
        {...(failureMessage ? { title: failureMessage } : {})}
      >
        {LABELS[status]}
      </span>
      {status === "blocked_configuration" ? (
        <Link
          href="/admin/settings/ai"
          className="text-text-2 text-xs underline"
        >
          Administration › Settings › AI
        </Link>
      ) : null}
    </span>
  );
}
