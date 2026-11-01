import { describe, expect, it } from "vitest";
import { visibleToolbarGroups } from "./toolbar-overflow";

describe("visibleToolbarGroups", () => {
  it("keeps every group when all share the first line", () => {
    expect(
      visibleToolbarGroups(
        [
          { top: 4, right: 120 },
          { top: 4, right: 300 },
          { top: 4, right: 420 },
        ],
        424,
      ),
    ).toBe(3);
  });

  it("collapses from the first group that wrapped to a later line", () => {
    expect(
      visibleToolbarGroups(
        [
          { top: 4, right: 120 },
          { top: 4, right: 300 },
          { top: 40, right: 90 },
          { top: 40, right: 200 },
        ],
        320,
      ),
    ).toBe(2);
  });

  it("treats everything after an overflowing group as overflowing", () => {
    expect(
      visibleToolbarGroups(
        [
          { top: 4, right: 120 },
          { top: 40, right: 300 },
          { top: 4, right: 180 },
        ],
        320,
      ),
    ).toBe(1);
  });

  it("collapses a first group wider than the row", () => {
    expect(visibleToolbarGroups([{ top: 4, right: 140 }], 100)).toBe(0);
  });

  it("ignores sub-pixel differences", () => {
    expect(
      visibleToolbarGroups(
        [
          { top: 4, right: 100.4 },
          { top: 4.5, right: 200.6 },
        ],
        200,
      ),
    ).toBe(2);
  });

  it("returns zero for an empty row", () => {
    expect(visibleToolbarGroups([], 300)).toBe(0);
  });
});
