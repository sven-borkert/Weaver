import { describe, expect, it, vi } from "vitest";

import { focusDialogTarget } from "./dialog-focus";

describe("focusDialogTarget", () => {
  it("returns focus to a connected dialog opener", () => {
    const focus = vi.fn();
    const fallbackFocus = vi.fn();
    const schedule = vi.fn((callback: () => void) => callback());

    focusDialogTarget(
      { isConnected: true, focus },
      { isConnected: true, focus: fallbackFocus },
      schedule,
    );

    expect(schedule).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(fallbackFocus).not.toHaveBeenCalled();
  });

  it("focuses a connected stable fallback when the opener was removed", () => {
    const primaryFocus = vi.fn();
    const fallbackFocus = vi.fn();

    focusDialogTarget(
      { isConnected: false, focus: primaryFocus },
      { isConnected: true, focus: fallbackFocus },
      (callback) => callback(),
    );

    expect(primaryFocus).not.toHaveBeenCalled();
    expect(fallbackFocus).toHaveBeenCalledOnce();
  });

  it("falls back when the opener is connected but disabled", () => {
    const primaryFocus = vi.fn();
    const fallbackFocus = vi.fn();

    focusDialogTarget(
      { isConnected: true, disabled: true, focus: primaryFocus },
      { isConnected: true, focus: fallbackFocus },
      (callback) => callback(),
    );

    expect(primaryFocus).not.toHaveBeenCalled();
    expect(fallbackFocus).toHaveBeenCalledOnce();
  });

  it("does not focus a disabled fallback either", () => {
    const focus = vi.fn();

    focusDialogTarget(
      null,
      { isConnected: true, disabled: true, focus },
      (callback) => callback(),
    );

    expect(focus).not.toHaveBeenCalled();
  });

  it("does not focus a disconnected fallback", () => {
    const focus = vi.fn();

    focusDialogTarget(null, { isConnected: false, focus }, (callback) =>
      callback(),
    );

    expect(focus).not.toHaveBeenCalled();
  });
});
