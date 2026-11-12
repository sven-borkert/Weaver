import { describe, expect, it } from "vitest";
import { externalConnectionListInput, externalToolsInput } from "./externalMcp";
import { createTaskInput, listTaskRunsInput } from "./scheduledTask";

describe("API input bounds", () => {
  it.each([
    externalConnectionListInput.shape.cursor,
    externalToolsInput.shape.cursor,
    listTaskRunsInput.shape.cursor,
  ])("rejects oversized cursors", (schema) => {
    expect(schema.safeParse("a".repeat(2048)).success).toBe(true);
    expect(schema.safeParse("a".repeat(2049)).success).toBe(false);
  });

  it("validates scheduled output paths with the canonical segment rules", () => {
    const schema = createTaskInput.shape.outputFolderPath;
    expect(schema.safeParse([]).success).toBe(true);
    expect(schema.safeParse(["reports", "weekly-updates"]).success).toBe(true);
    for (const path of [[".."], ["a/b"], ["bad name"], ["."]])
      expect(schema.safeParse(path).success).toBe(false);
  });
});
