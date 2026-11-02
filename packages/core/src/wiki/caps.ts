import type { WikiRunKindName } from "./states";

/** The §8.2 cap table. Null means the kind has no such limit. */
export const WIKI_RUN_CAPS: Record<
  WikiRunKindName,
  { writes: number; steps: number | null; wallClockMs: number }
> = {
  ingest: { writes: 120, steps: 400, wallClockMs: 2 * 60 * 60_000 },
  lint: { writes: 60, steps: 300, wallClockMs: 60 * 60_000 },
  classify: { writes: 100, steps: null, wallClockMs: 60 * 60_000 },
  revert: { writes: 9_999, steps: null, wallClockMs: 30 * 60_000 },
};
