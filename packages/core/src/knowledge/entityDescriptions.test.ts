import { describe, expect, it } from "vitest";
import { selectEntityDescription } from "./entityDescriptions";

describe("current entity descriptions", () => {
  it("selects supported current evidence deterministically across sources", () => {
    const sources = [
      { documentId: "b", description: "Secondary source", confidence: 0.7 },
      { documentId: "a", description: "Corrected source", confidence: 0.9 },
      { documentId: "c", description: null, confidence: 1 },
    ];
    expect(selectEntityDescription(sources)).toBe("Corrected source");
    expect(selectEntityDescription([...sources].reverse())).toBe(
      "Corrected source",
    );
    expect(selectEntityDescription(sources.slice(0, 1))).toBe(
      "Secondary source",
    );
    expect(selectEntityDescription([])).toBeNull();
  });
});
