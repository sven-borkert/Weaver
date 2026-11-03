import type { WikiRunRow } from "@weaver/core/services/wikiRunViews";

const STATUS_LABELS: Record<string, string> = {
  preparing: "Preparing",
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  stopped: "Stopped",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function wikiRunStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

const STOP_REASONS: Record<string, string> = {
  destructive_budget: "stopped after three writes went over the page limits",
  destructive_pause:
    "changes in the last 24 hours are over the project's budget",
  write_cap: "reached the write limit for one run",
  step_cap: "reached the step limit for one run",
  wall_clock: "reached the time limit for one run",
  model_stopped: "the model stopped before finishing",
  unfinished_items: "finished with some inputs still unfinished",
  no_ready_items: "no input was ready",
  no_worker: "no worker is consuming wiki runs",
  fence_closed: "the wiki was disabled or its agent changed",
  wiki_disabled: "the wiki was disabled",
  user: "cancelled by a person",
  revert_interrupted: "the revert was interrupted",
  no_candidates: "no page needs a type or summary",
  no_proposals: "the model proposed nothing usable",
  plan_rejected: "the plan was rejected",
  plan_expired: "the plan was not accepted within a day",
  classify_interrupted: "the classification was interrupted",
};

const ERROR_LABELS: Record<string, string> = {
  ROUTE_UNSUITABLE:
    "The model routed to the wiki agent is missing or too small. An administrator can change it in Administration, AI.",
  GUIDE_UNAVAILABLE:
    "The approved guide is missing or changed. A Maintainer can review and approve it in Settings.",
  CONTEXT_LIMIT: "The run outgrew the model's context window.",
  LEASE_LOST: "The worker stopped responding three times.",
  NO_WORKER: "No worker is consuming wiki runs.",
  PLAN_INVALID: "The stored plan failed validation, so nothing was applied.",
  RUNNER_UNAVAILABLE: "This worker cannot run the wiki agent.",
};

/** One sentence for the run list; codes never reach the page. */
export function wikiRunOutcome(
  run: Pick<WikiRunRow, "status" | "stopReason" | "errorCode" | "errorMessage">,
): string | null {
  if (run.errorCode && ERROR_LABELS[run.errorCode])
    return ERROR_LABELS[run.errorCode]!;
  if (run.errorMessage) return run.errorMessage;
  if (run.stopReason) return STOP_REASONS[run.stopReason] ?? "The run stopped.";
  return null;
}

const SKIP_REASONS: Record<string, string> = {
  edited_after_run: "someone edited it after the run",
  later_run: "a later wiki run changed it",
  gone: "it no longer exists",
  source_page: "source pages are never touched",
};

export function wikiSkipReason(reason: string): string {
  return SKIP_REASONS[reason] ?? "it could not be reverted";
}

export function wikiDuration(start: Date, end: Date | null): string {
  if (!end) return "";
  const seconds = Math.max(
    0,
    Math.round((end.getTime() - start.getTime()) / 1000),
  );
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function wikiCost(micros: bigint, currency: string | null): string {
  const amount = Number(micros) / 1_000_000;
  const text = amount.toFixed(amount !== 0 && amount < 0.01 ? 4 : 2);
  return currency ? `${text} ${currency}` : text;
}

export function wikiVersionHref(
  projectId: string,
  documentId: string,
  sha: string,
): string {
  return `/projects/${projectId}/documents/${documentId}?version=${sha}`;
}
