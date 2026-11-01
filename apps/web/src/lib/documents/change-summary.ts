const RENAME_PREFIX = "Rename to ";
export const MAX_CHANGE_SUMMARY_LENGTH = 120;

export function isSingleLineChangeSummary(value: string): boolean {
  return !/[\x00-\x1f\x7f\u2028\u2029]/.test(value);
}

export function buildRenameChangeSummary(title: string): string {
  const maximumTitleLength = MAX_CHANGE_SUMMARY_LENGTH - RENAME_PREFIX.length;
  if (title.length <= maximumTitleLength) return `${RENAME_PREFIX}${title}`;

  return `${RENAME_PREFIX}${title.slice(0, maximumTitleLength - 1)}…`;
}

export const CHANGE_SUMMARY_FAST_POLL_MS = 5_000;
export const CHANGE_SUMMARY_SLOW_POLL_MS = 30_000;
const FAST_POLL_WINDOW_MS = 2 * 60_000;
const SLOW_POLL_WINDOW_MS = 15 * 60_000;

export function changeSummaryRefetchInterval(
  data:
    | {
        entries: ReadonlyArray<{
          date: Date;
          changeSummary: { status: string } | null;
        }>;
      }
    | undefined,
  now: number,
): number | false {
  let newest: number | null = null;
  for (const entry of data?.entries ?? []) {
    if (entry.changeSummary?.status !== "pending") continue;
    const time = entry.date.getTime();
    if (newest === null || time > newest) newest = time;
  }
  if (newest === null) return false;
  const age = now - newest;
  if (age < FAST_POLL_WINDOW_MS) return CHANGE_SUMMARY_FAST_POLL_MS;
  if (age < SLOW_POLL_WINDOW_MS) return CHANGE_SUMMARY_SLOW_POLL_MS;
  return false;
}
