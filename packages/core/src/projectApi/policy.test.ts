import { describe, expect, it } from "vitest";
import { folderContains } from "./policy";
describe("machine folder containment", () => {
  it("compares complete segments and includes descendants", () => {
    expect(folderContains(["audit"], ["audit-other", "report"])).toBe(false);
    expect(folderContains(["audit"], ["audit", "2026", "report"])).toBe(true);
    expect(folderContains([], ["audit"])).toBe(true);
  });
});
