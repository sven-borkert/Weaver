import { describe, expect, it, vi } from "vitest";

import {
  DOCUMENT_CONTEXT_RAIL_KEY,
  parsePanelPreference,
  readPanelPreference,
  writePanelPreference,
} from "./panel-state";

describe("parsePanelPreference", () => {
  it("accepts only the stored panel states", () => {
    expect(parsePanelPreference("open")).toBe(true);
    expect(parsePanelPreference("closed")).toBe(false);
    expect(parsePanelPreference(null)).toBeUndefined();
    expect(parsePanelPreference("broken")).toBeUndefined();
  });
});

describe("panel preference storage", () => {
  it("reads and validates the context-rail preference", () => {
    const getItem = vi.fn(() => "open");

    expect(readPanelPreference({ getItem })).toBe(true);
    expect(getItem).toHaveBeenCalledWith(DOCUMENT_CONTEXT_RAIL_KEY);
  });

  it("returns undefined when storage is unavailable", () => {
    const getItem = vi.fn(() => {
      throw new DOMException("Storage is blocked", "SecurityError");
    });

    expect(readPanelPreference({ getItem })).toBeUndefined();
  });

  it.each([
    [true, "open"],
    [false, "closed"],
  ])("writes %s as %s", (open, storedValue) => {
    const setItem = vi.fn();

    expect(writePanelPreference({ setItem }, open)).toBe(true);
    expect(setItem).toHaveBeenCalledWith(
      DOCUMENT_CONTEXT_RAIL_KEY,
      storedValue,
    );
  });

  it("reports when storage rejects a write", () => {
    const setItem = vi.fn(() => {
      throw new DOMException("Storage is full", "QuotaExceededError");
    });

    expect(writePanelPreference({ setItem }, true)).toBe(false);
  });
});
