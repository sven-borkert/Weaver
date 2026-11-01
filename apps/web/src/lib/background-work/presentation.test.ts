import { describe, expect, it } from "vitest";

import type {
  BackgroundWorkItem,
  BackgroundWorkSummary,
} from "@weaver/core/jobs/backgroundWorkSchema";
import {
  visibleWorkReferences,
  workBadgeLabel,
  workPollInterval,
  workStatusLabel,
} from "./presentation";

const summary = (
  active: number,
  unseen: number,
  capped = false,
): BackgroundWorkSummary => ({
  active: { value: active, capped },
  unseen: { value: unseen, capped },
  observedAt: "2026-09-08T10:00:00.000Z",
});

describe("background work presentation", () => {
  it("stops polling while hidden and accelerates while open or active", () => {
    expect(
      workPollInterval({ open: false, active: false, hidden: false }),
    ).toBe(15_000);
    expect(workPollInterval({ open: true, active: false, hidden: false })).toBe(
      5_000,
    );
    expect(workPollInterval({ open: false, active: true, hidden: false })).toBe(
      5_000,
    );
    expect(workPollInterval({ open: true, active: true, hidden: true })).toBe(
      false,
    );
  });

  it("describes exact and capped bell counts", () => {
    expect(workBadgeLabel(summary(0, 0))).toBe("Background work");
    expect(workBadgeLabel(summary(2, 3))).toBe(
      "Background work: 2 active, 3 unseen results",
    );
    expect(workBadgeLabel(summary(100, 100, true))).toBe(
      "Background work: 99+ active, 99+ unseen results",
    );
  });

  it("extracts only visible unseen personal references", () => {
    const acknowledgement = {
      kind: "task",
      id: "work-1",
      revision: "a".repeat(32),
    } as const;
    const work5Acknowledgement = {
      kind: "knowledge",
      id: "work-5",
      revision: "b".repeat(32),
    } as const;
    const base = {
      acknowledgement,
      unseen: true,
      kind: "task",
      state: "succeeded",
    } as BackgroundWorkItem;
    expect(
      visibleWorkReferences([
        base,
        { ...base, id: "work-2", unseen: false },
        { ...base, id: "work-3", acknowledgement: null },
        { ...base, id: "work-4", state: "running" },
        {
          ...base,
          id: "work-5",
          kind: "knowledge",
          acknowledgement: work5Acknowledgement,
        },
      ]),
    ).toEqual([acknowledgement, work5Acknowledgement]);
  });

  it("uses normalized state for an active knowledge generation", () => {
    expect(
      workStatusLabel({
        kind: "knowledge",
        sourceStatus: "active",
        state: "running",
      }),
    ).toBe("Updating knowledge index");
    expect(
      workStatusLabel({
        kind: "knowledge",
        sourceStatus: "active",
        state: "queued",
      }),
    ).toBe("Updating knowledge index");
    expect(
      workStatusLabel({
        kind: "knowledge",
        sourceStatus: "active",
        state: "failed",
      }),
    ).toBe("Failed");
  });

  it.each([
    ["import", "ready", "Ready for review"],
    ["import", "accepting", "Saving import"],
    ["import", "parsing", "Parsing"],
    ["assistant", "cancelling", "Cancelling"],
    ["knowledge", "active", "Knowledge index ready"],
    ["task", "anything", "Succeeded"],
  ] as const)("labels %s source status %s", (kind, sourceStatus, label) => {
    expect(workStatusLabel({ kind, sourceStatus, state: "succeeded" })).toBe(
      label,
    );
  });
});
