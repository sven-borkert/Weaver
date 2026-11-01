import { expect, it } from "vitest";
import { hasPersistedRunOutcome } from "./persistedRun";

it("retains streamed text until the matching run has a persisted outcome", () => {
  expect(
    hasPersistedRunOutcome("a", [
      { runId: "a", role: "user", status: "pending" },
    ]),
  ).toBe(false);
  expect(
    hasPersistedRunOutcome("a", [
      { runId: "b", role: "assistant", status: "complete" },
    ]),
  ).toBe(false);
  expect(
    hasPersistedRunOutcome("a", [
      { runId: "a", role: "assistant", status: "complete" },
    ]),
  ).toBe(true);
  expect(
    hasPersistedRunOutcome("a", [
      { runId: "a", role: "user", status: "cancelled" },
    ]),
  ).toBe(true);
});
