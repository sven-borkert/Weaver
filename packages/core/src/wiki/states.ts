export const WIKI_NOTE_MAX_CHARS = 200_000;
export const WIKI_QUEUE_MAX_ITEMS = 200;
export const WIKI_INGEST_MAX_ITEMS = 10;
export const WIKI_PREPARING_LIMIT_MS = 75 * 60_000;
export const WIKI_NO_WORKER_LIMIT_MS = 10 * 60_000;

export const WIKI_INPUT_STATUSES = [
  "queued",
  "preparing",
  "ready",
  "processing",
  "processed",
  "skipped",
  "held",
  "failed",
  "reverted",
  "removed",
] as const;
export type WikiInputStatusName = (typeof WIKI_INPUT_STATUSES)[number];

export const WIKI_RUN_STATUSES = [
  "preparing",
  "queued",
  "running",
  "succeeded",
  "stopped",
  "failed",
  "cancelled",
] as const;
export type WikiRunStatusName = (typeof WIKI_RUN_STATUSES)[number];

export const WIKI_ACTIVE_RUN_STATUSES = [
  "preparing",
  "queued",
  "running",
] as const satisfies readonly WikiRunStatusName[];

/** Item states a terminal run hands back to the queue with a note. */
export const WIKI_IN_RUN_ITEM_STATUSES = [
  "preparing",
  "ready",
  "processing",
] as const satisfies readonly WikiInputStatusName[];

export const WIKI_QUEUE_ITEM_STATUSES = [
  "queued",
  ...WIKI_IN_RUN_ITEM_STATUSES,
] as const satisfies readonly WikiInputStatusName[];

export const WIKI_ATTENTION_ITEM_STATUSES = [
  "skipped",
  "held",
  "failed",
  "reverted",
] as const satisfies readonly WikiInputStatusName[];

/** An artifact stops being protected once its item failed or was removed. */
export const WIKI_UNPROTECTING_ITEM_STATUSES = [
  "failed",
  "removed",
] as const satisfies readonly WikiInputStatusName[];

const ITEM_TRANSITIONS: Record<
  WikiInputStatusName,
  readonly WikiInputStatusName[]
> = {
  queued: ["preparing", "removed"],
  preparing: ["ready", "held", "failed", "queued", "removed"],
  ready: ["processing", "queued", "removed"],
  processing: ["processed", "skipped", "failed", "queued"],
  processed: ["reverted"],
  skipped: ["queued", "removed"],
  held: ["queued", "removed"],
  failed: ["queued", "removed"],
  reverted: ["queued", "removed"],
  removed: [],
};

const RUN_TRANSITIONS: Record<WikiRunStatusName, readonly WikiRunStatusName[]> =
  {
    preparing: ["queued", "stopped", "failed", "cancelled"],
    queued: ["running", "failed", "cancelled"],
    running: ["succeeded", "stopped", "failed", "cancelled"],
    succeeded: [],
    stopped: [],
    failed: [],
    cancelled: [],
  };

export function canTransitionInput(
  from: WikiInputStatusName,
  to: WikiInputStatusName,
): boolean {
  return ITEM_TRANSITIONS[from].includes(to);
}

export function canTransitionRun(
  from: WikiRunStatusName,
  to: WikiRunStatusName,
): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function isTerminalRunStatus(status: WikiRunStatusName): boolean {
  return RUN_TRANSITIONS[status].length === 0;
}

export function inputsThatCanMoveTo(
  to: WikiInputStatusName,
): WikiInputStatusName[] {
  return WIKI_INPUT_STATUSES.filter((from) => canTransitionInput(from, to));
}

/** The run's next status once no item is still being prepared. */
export function afterPreparation(
  items: ReadonlyArray<{ status: WikiInputStatusName }>,
): "queued" | "stopped" | null {
  if (items.some((item) => item.status === "preparing")) return null;
  return items.some((item) => item.status === "ready") ? "queued" : "stopped";
}
