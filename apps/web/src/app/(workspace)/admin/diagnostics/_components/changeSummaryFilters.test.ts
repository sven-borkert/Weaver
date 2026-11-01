import { describe, expect, it } from "vitest";
import {
  changeSummaryEventsHref,
  changeSummaryListInput,
  completionDuration,
} from "./changeSummaryFilters";

describe("change summary filters", () => {
  it("builds list input from the selected filters", () => {
    expect(
      changeSummaryListInput({ status: "all", projectId: "all" }, undefined),
    ).toEqual({ limit: 25 });
    expect(
      changeSummaryListInput({ status: "failed", projectId: "p1" }, "c1"),
    ).toEqual({ limit: 25, cursor: "c1", status: "failed", projectId: "p1" });
  });

  it("links to the events for a document and job", () => {
    expect(changeSummaryEventsHref({ documentId: "d1", lastJobId: "j1" })).toBe(
      "/admin/diagnostics?documentId=d1&jobId=j1#events",
    );
    expect(changeSummaryEventsHref({ documentId: "d1", lastJobId: null })).toBe(
      "/admin/diagnostics?documentId=d1#events",
    );
  });

  it("formats the time to completion", () => {
    const createdAt = new Date("2026-09-16T00:00:00.000Z");
    const after = (ms: number) => new Date(createdAt.getTime() + ms);
    expect(completionDuration({ createdAt, completedAt: null })).toBe("—");
    expect(completionDuration({ createdAt, completedAt: after(450) })).toBe(
      "450 ms",
    );
    expect(completionDuration({ createdAt, completedAt: after(5_150) })).toBe(
      "5.2 s",
    );
    expect(completionDuration({ createdAt, completedAt: after(128_000) })).toBe(
      "2 min",
    );
  });
});
