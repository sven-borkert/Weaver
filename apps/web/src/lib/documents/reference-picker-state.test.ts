import { describe, expect, it } from "vitest";
import {
  activeReferencePickerView,
  referencePickerTabSemantics,
  resolveReferencePickerPresentation,
  switchReferenceTargetType,
  updateActiveReferenceQuery,
  type ReferencePickerState,
} from "./reference-picker-state";

describe("resolveReferencePickerPresentation", () => {
  it.each([
    {
      name: "retained results after a refetch error",
      input: { itemCount: 2, isLoading: false, hasError: true },
      expected: "results",
    },
    {
      name: "initial loading without results",
      input: { itemCount: 0, isLoading: true, hasError: false },
      expected: "loading",
    },
    {
      name: "initial error without results",
      input: { itemCount: 0, isLoading: false, hasError: true },
      expected: "error",
    },
    {
      name: "settled empty results",
      input: { itemCount: 0, isLoading: false, hasError: false },
      expected: "empty",
    },
  ] as const)("returns $expected for $name", ({ input, expected }) => {
    expect(resolveReferencePickerPresentation(input)).toBe(expected);
  });
});

describe("typed reference picker state", () => {
  const state: ReferencePickerState = {
    activeType: "document",
    activeIndex: 3,
    queries: { document: "architecture", table: "roadmap" },
  };

  it("resets only the active index when switching tabs", () => {
    expect(switchReferenceTargetType(state, "table")).toEqual({
      activeType: "table",
      activeIndex: 0,
      queries: { document: "architecture", table: "roadmap" },
    });
  });

  it("updates only the active tab query", () => {
    expect(updateActiveReferenceQuery(state, "design")).toEqual({
      activeType: "document",
      activeIndex: 0,
      queries: { document: "design", table: "roadmap" },
    });
  });

  it("presents only the active tab query and results", () => {
    expect(
      activeReferencePickerView(switchReferenceTargetType(state, "table"), {
        document: {
          items: [{ id: "document-result" }],
          isLoading: false,
          hasError: true,
        },
        table: {
          items: [{ id: "table-result" }],
          isLoading: false,
          hasError: false,
        },
      }),
    ).toEqual({
      targetType: "table",
      query: "roadmap",
      items: [{ id: "table-result" }],
      activeIndex: 0,
      presentation: "results",
      hasError: false,
    });
  });

  it("provides unique controls and exact accessible labels for each tab", () => {
    expect(referencePickerTabSemantics("document", "picker")).toEqual({
      comboboxId: "picker-document-search",
      listboxId: "picker-document-results",
      searchLabel: "Search documents",
      matchingLabel: "Matching documents",
    });
    expect(referencePickerTabSemantics("table", "picker")).toEqual({
      comboboxId: "picker-table-search",
      listboxId: "picker-table-results",
      searchLabel: "Search tables",
      matchingLabel: "Matching tables",
    });
  });
});
