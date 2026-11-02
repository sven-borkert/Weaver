import type {
  BackgroundWorkItem,
  BackgroundWorkSummary,
  WorkReference,
} from "@weaver/core/jobs/backgroundWorkSchema";

export const WORK_KIND_LABELS = {
  task: "Task",
  import: "Import",
  assistant: "Assistant",
  knowledge: "Knowledge",
  notebook: "OneNote",
  git_sync: "Git sync",
  exam: "Exam",
  wiki: "Wiki",
} as const;

export const WORK_STATE_LABELS = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  blocked: "Needs attention",
  cancelled: "Cancelled",
  skipped: "Skipped",
} as const;

const SOURCE_STATUS_LABELS: Partial<
  Record<BackgroundWorkItem["kind"], Record<string, string>>
> = {
  import: {
    parsing: "Parsing",
    extracting: "Analysing",
    linking: "Linking",
    ready: "Ready for review",
    accepting: "Saving import",
    accepted: "Accepted",
    rejected: "Rejected",
    blocked_configuration: "Needs configuration",
  },
  assistant: { cancelling: "Cancelling" },
  exam: {
    in_progress: "Exam in progress",
    submitted: "Waiting for grading",
    in_review: "Waiting for grading",
    released: "Graded",
  },
  wiki: {
    preparing: "Preparing sources",
    queued: "Waiting for a worker",
    running: "Running",
    stopped: "Stopped",
  },
  knowledge: {
    building: "Building knowledge index",
    superseded: "Build superseded",
  },
  notebook: {
    queued: "Waiting to prepare",
    running: "Preparing notebook",
    ready: "Notebook ready",
  },
};

export function workStatusLabel(
  item: Pick<BackgroundWorkItem, "kind" | "sourceStatus" | "state">,
): string {
  if (item.kind === "knowledge" && item.sourceStatus === "active") {
    if (item.state === "queued" || item.state === "running")
      return "Updating knowledge index";
    if (item.state === "succeeded") return "Knowledge index ready";
  }
  return (
    SOURCE_STATUS_LABELS[item.kind]?.[item.sourceStatus] ??
    WORK_STATE_LABELS[item.state]
  );
}

export function workPollInterval(input: {
  open: boolean;
  active: boolean;
  hidden: boolean;
}): number | false {
  if (input.hidden) return false;
  return input.open || input.active ? 5_000 : 15_000;
}

function countLabel(value: number, capped: boolean): string {
  return capped || value >= 100 ? "99+" : String(value);
}

export function workBadgeLabel(
  summary: BackgroundWorkSummary | undefined,
): string {
  if (!summary) return "Background work";
  const parts: string[] = [];
  if (summary.active.value > 0)
    parts.push(
      `${countLabel(summary.active.value, summary.active.capped)} active`,
    );
  if (summary.unseen.value > 0)
    parts.push(
      `${countLabel(summary.unseen.value, summary.unseen.capped)} unseen results`,
    );
  return parts.length === 0
    ? "Background work"
    : `Background work: ${parts.join(", ")}`;
}

export function visibleWorkReferences(
  items: BackgroundWorkItem[],
): WorkReference[] {
  return items
    .filter(
      (item) =>
        item.unseen &&
        item.acknowledgement !== null &&
        item.state !== "queued" &&
        item.state !== "running",
    )
    .map((item) => item.acknowledgement!);
}
