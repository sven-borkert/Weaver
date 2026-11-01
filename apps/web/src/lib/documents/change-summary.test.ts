import { describe, expect, it } from "vitest";

import {
  buildRenameChangeSummary,
  CHANGE_SUMMARY_FAST_POLL_MS,
  CHANGE_SUMMARY_SLOW_POLL_MS,
  changeSummaryRefetchInterval,
} from "./change-summary";

describe("buildRenameChangeSummary", () => {
  it("keeps a title that exactly fits the change-summary limit", () => {
    const title = "a".repeat(110);

    expect(buildRenameChangeSummary(title)).toBe(`Rename to ${title}`);
    expect(buildRenameChangeSummary(title)).toHaveLength(120);
  });

  it("truncates a 200-character title with a final ellipsis", () => {
    const summary = buildRenameChangeSummary("a".repeat(200));

    expect(summary).toBe(`Rename to ${"a".repeat(109)}…`);
    expect(summary).toHaveLength(120);
  });
});

describe("changeSummaryRefetchInterval", () => {
  const now = Date.parse("2026-09-16T12:00:00.000Z");
  const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000);

  it("polls fast, then slowly, then stops based on the newest pending entry", () => {
    expect(changeSummaryRefetchInterval(undefined, now)).toBe(false);
    expect(
      changeSummaryRefetchInterval(
        {
          entries: [
            { date: minutesAgo(1), changeSummary: { status: "ready" } },
            { date: minutesAgo(1), changeSummary: null },
          ],
        },
        now,
      ),
    ).toBe(false);
    expect(
      changeSummaryRefetchInterval(
        {
          entries: [
            { date: minutesAgo(20), changeSummary: { status: "pending" } },
            { date: minutesAgo(1), changeSummary: { status: "pending" } },
          ],
        },
        now,
      ),
    ).toBe(CHANGE_SUMMARY_FAST_POLL_MS);
    expect(
      changeSummaryRefetchInterval(
        {
          entries: [
            { date: minutesAgo(5), changeSummary: { status: "pending" } },
          ],
        },
        now,
      ),
    ).toBe(CHANGE_SUMMARY_SLOW_POLL_MS);
    expect(
      changeSummaryRefetchInterval(
        {
          entries: [
            { date: minutesAgo(16), changeSummary: { status: "pending" } },
          ],
        },
        now,
      ),
    ).toBe(false);
    expect([CHANGE_SUMMARY_FAST_POLL_MS, CHANGE_SUMMARY_SLOW_POLL_MS]).toEqual([
      5_000, 30_000,
    ]);
  });
});
