import { describe, expect, it, vi } from "vitest";

import {
  TABLE_CONTEXT_RAIL_KEY,
  getTableHistoryEntryState,
  readTablePanelPreference,
  shouldMountTableContextData,
  writeTablePanelPreference,
} from "./panel-state";

describe("table context-rail preference", () => {
  it.each([
    ["open", true],
    ["closed", false],
    [null, undefined],
    ["invalid", undefined],
  ] as const)("reads %s safely", (stored, expected) => {
    const getItem = vi.fn(() => stored);

    expect(readTablePanelPreference({ getItem })).toBe(expected);
    expect(getItem).toHaveBeenCalledWith(TABLE_CONTEXT_RAIL_KEY);
  });

  it("defaults safely when session storage cannot be read", () => {
    const getItem = vi.fn(() => {
      throw new DOMException("Storage is blocked", "SecurityError");
    });

    expect(readTablePanelPreference({ getItem })).toBeUndefined();
  });

  it.each([
    [true, "open"],
    [false, "closed"],
  ] as const)("persists %s as %s", (open, stored) => {
    const setItem = vi.fn();

    expect(writeTablePanelPreference({ setItem }, open)).toBe(true);
    expect(setItem).toHaveBeenCalledWith(TABLE_CONTEXT_RAIL_KEY, stored);
  });

  it("reports safely when session storage rejects a write", () => {
    const setItem = vi.fn(() => {
      throw new DOMException("Storage is blocked", "SecurityError");
    });

    expect(writeTablePanelPreference({ setItem }, true)).toBe(false);
  });
});

describe("table context data mounting", () => {
  it.each([
    {
      name: "closed wide rail",
      railOpen: false,
      drawerOpen: false,
      expected: false,
    },
    {
      name: "open wide rail",
      railOpen: true,
      drawerOpen: false,
      expected: true,
    },
    {
      name: "open narrow drawer",
      railOpen: false,
      drawerOpen: true,
      expected: true,
    },
  ])("mounts data for $name only when visible", (state) => {
    expect(shouldMountTableContextData(state)).toBe(state.expected);
  });
});

describe("table history entry semantics", () => {
  const CURRENT_SHA = "a".repeat(40);
  const SELECTED_SHA = "b".repeat(40);

  it("marks only the canonical current SHA as current", () => {
    expect(
      getTableHistoryEntryState(CURRENT_SHA, SELECTED_SHA, CURRENT_SHA),
    ).toEqual({ current: true, selected: false });
  });

  it("represents a selected historical SHA separately", () => {
    expect(
      getTableHistoryEntryState(CURRENT_SHA, SELECTED_SHA, SELECTED_SHA),
    ).toEqual({ current: false, selected: true });
  });

  it("leaves unrelated history entries unmarked", () => {
    expect(
      getTableHistoryEntryState(CURRENT_SHA, SELECTED_SHA, "c".repeat(40)),
    ).toEqual({ current: false, selected: false });
  });
});
