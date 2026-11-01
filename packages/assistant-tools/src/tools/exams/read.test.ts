import { expect, it, vi } from "vitest";
import { decodePageCursor } from "@weaver/core/services/adminPaging";
import type { ToolContext } from "../../contract";
import { listExamAttemptsTool } from "./read";
const listAttempts = vi.hoisted(() => vi.fn());
vi.mock("@weaver/core/services/examAttempts", () => ({
  listAttempts,
  getAttemptForReview: vi.fn(),
}));
vi.mock("@weaver/core/services/projectTraining", () => ({
  assertTrainer: vi.fn(),
  trainerProjectIds: vi.fn().mockResolvedValue(["project"]),
}));
it("continues byte-trimmed attempt pages by start time, even when submission differs", async () => {
  const items = Array.from({ length: 50 }, (_, i) => ({
    id: `attempt-${i}`,
    examTitle: "漢".repeat(200),
    startedAt: new Date("2026-10-20T10:00:00Z"),
    deadlineAt: new Date("2026-10-20T10:30:00Z"),
    submittedAt: new Date("2026-10-20T10:15:00Z"),
    gradedAt: null,
    releasedAt: null,
  }));
  listAttempts.mockResolvedValue({ items, nextCursor: null });
  const ctx = {
    db: {},
    actor: {},
    scope: { projectIds: ["project"] },
  } as unknown as ToolContext;
  const { output } = await listExamAttemptsTool.execute(
    { status: "waiting" },
    ctx,
  );
  expect(output.items.length).toBeGreaterThan(0);
  expect(output.items.length).toBeLessThan(50);
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(16000);
  expect(decodePageCursor(output.nextCursor!, 2)).toEqual([
    "2026-10-20T10:00:00.000Z",
    output.items.at(-1)!.id,
  ]);
});
