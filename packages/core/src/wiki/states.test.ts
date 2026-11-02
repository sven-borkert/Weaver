import { describe, expect, it } from "vitest";
import {
  afterPreparation,
  canTransitionInput,
  canTransitionRun,
  inputsThatCanMoveTo,
  isTerminalRunStatus,
  WIKI_INPUT_STATUSES,
  WIKI_RUN_STATUSES,
} from "./states";

describe("item transitions", () => {
  it.each([
    ["queued", "preparing"],
    ["preparing", "ready"],
    ["ready", "processing"],
    ["processing", "processed"],
    ["processing", "skipped"],
    ["preparing", "held"],
    ["preparing", "failed"],
    ["held", "queued"],
    ["failed", "queued"],
    ["skipped", "queued"],
    ["processed", "reverted"],
    ["reverted", "queued"],
    ["preparing", "queued"],
    ["ready", "queued"],
    ["processing", "queued"],
  ] as const)("allows %s to %s", (from, to) => {
    expect(canTransitionInput(from, to)).toBe(true);
  });

  it.each([
    ["processed", "queued"],
    ["processed", "removed"],
    ["queued", "ready"],
    ["held", "ready"],
    ["removed", "queued"],
    ["processing", "removed"],
  ] as const)("refuses %s to %s", (from, to) => {
    expect(canTransitionInput(from, to)).toBe(false);
  });

  it("removed is terminal and every other state but processing and processed can reach it", () => {
    expect(inputsThatCanMoveTo("removed").sort()).toEqual(
      WIKI_INPUT_STATUSES.filter(
        (status) => !["processing", "processed", "removed"].includes(status),
      ).sort(),
    );
  });
});

describe("run transitions", () => {
  it("has exactly four terminal states", () => {
    expect(WIKI_RUN_STATUSES.filter(isTerminalRunStatus)).toEqual([
      "succeeded",
      "stopped",
      "failed",
      "cancelled",
    ]);
  });
  it.each([
    ["preparing", "queued", true],
    ["preparing", "running", false],
    ["queued", "running", true],
    ["queued", "succeeded", false],
    ["running", "succeeded", true],
    ["cancelled", "queued", false],
  ] as const)("%s to %s is %s", (from, to, expected) => {
    expect(canTransitionRun(from, to)).toBe(expected);
  });
});

describe("afterPreparation", () => {
  it("waits while an item is preparing", () => {
    expect(
      afterPreparation([{ status: "ready" }, { status: "preparing" }]),
    ).toBeNull();
  });
  it("queues when an item is ready, whatever else was held or failed", () => {
    expect(
      afterPreparation([
        { status: "ready" },
        { status: "held" },
        { status: "failed" },
      ]),
    ).toBe("queued");
  });
  it("stops when nothing is left for a model", () => {
    expect(afterPreparation([{ status: "held" }, { status: "failed" }])).toBe(
      "stopped",
    );
    expect(afterPreparation([])).toBe("stopped");
  });
});
