import { afterEach, expect, it, vi } from "vitest";
import { observeContentTransaction } from "./transactionTiming";

const emit = vi.hoisted(() => vi.fn());
vi.mock("./writer", () => ({ emitDiagnostic: emit }));
afterEach(() => {
  vi.restoreAllMocks();
  emit.mockClear();
});

it("reports a slow transaction without changing its result", async () => {
  vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(7000);
  await expect(
    observeContentTransaction(
      "project.create",
      "project-id",
      async () => "created",
    ),
  ).resolves.toBe("created");
  expect(emit).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "database.transaction.slow",
      durationMs: 6000,
      projectId: "project-id",
    }),
  );
});

it("preserves a failure while reporting a slow transaction", async () => {
  vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(7000);
  const error = new Error("rolled back");
  await expect(
    observeContentTransaction("project.key-policy", "project-id", async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(emit).toHaveBeenCalledOnce();
});

it("does not emit for ordinary transaction durations", async () => {
  await observeContentTransaction(
    "project.create",
    "project-id",
    async () => undefined,
  );
  expect(emit).not.toHaveBeenCalled();
});
