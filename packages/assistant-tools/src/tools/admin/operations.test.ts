import { describe, expect, it, vi } from "vitest";
import { aiUsageSummary } from "@weaver/core/services/aiUsageQueries";
import { queueSummary } from "@weaver/core/services/queueInspection";
import type { ToolContext } from "../../contract";
import { aiUsageSummaryTool, queueSummaryTool } from "./operations";

vi.mock("@weaver/core/services/aiUsageQueries", () => ({
  aiUsageSummary: vi.fn(),
  listAiUsage: vi.fn(),
}));
vi.mock(
  import("@weaver/core/services/queueInspection"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    queueSummary: vi.fn(),
  }),
);

const context = {} as ToolContext;

describe("admin summary output boundaries", () => {
  it("bounds queue summaries when schedules are empty at the JSON boundary", async () => {
    const page = {
      queues: Array.from({ length: 200 }, () => ({
        name: "q",
        state: "created",
        count: 1,
        oldestCreatedOn: null,
      })),
      schedules: [],
      truncated: false,
    };
    const extra = 16_001 - JSON.stringify(page).length;
    page.queues.forEach((row, index) => {
      row.name += "q".repeat(Math.min(79, Math.max(0, extra - index * 79)));
    });
    expect(JSON.stringify(page).length).toBe(16_001);
    vi.mocked(queueSummary).mockResolvedValue(page);

    const { output } = await queueSummaryTool.execute({}, context);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(16_000);
    expect(output.truncated).toBe(true);
    expect(output.queues.length).toBeGreaterThan(0);
    expect(output.queues.length).toBeLessThan(200);
    expect(output.schedules).toEqual([]);
  });

  it("reserves the longer false flag before bounding usage groups", async () => {
    const page = {
      groups: Array.from({ length: 100 }, () => ({
        key: "m",
        calls: 1,
        failures: 0,
        inputTokens: 1,
        outputTokens: 0,
        costMicros: 0,
        averageDurationMs: 1,
        currency: "USD",
        unpricedCalls: 0,
      })),
      truncated: false,
    };
    const extra = 16_001 - JSON.stringify(page).length;
    page.groups.forEach((row, index) => {
      row.key += "m".repeat(Math.min(199, Math.max(0, extra - index * 199)));
    });
    expect(JSON.stringify(page).length).toBe(16_001);
    vi.mocked(aiUsageSummary).mockResolvedValue(page);

    const { output } = await aiUsageSummaryTool.execute(
      { groupBy: "model" },
      context,
    );
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(16_000);
    expect(output.truncated).toBe(true);
    expect(output.groups.length).toBeGreaterThan(0);
    expect(output.groups.length).toBeLessThan(100);
  });
});
