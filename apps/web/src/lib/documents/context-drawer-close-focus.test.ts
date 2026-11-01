import { describe, expect, it } from "vitest";

import {
  consumeContextDrawerCloseFocus,
  DEFAULT_CONTEXT_DRAWER_CLOSE_FOCUS,
  requestSelectionCloseFocus,
} from "./context-drawer-close-focus";

describe("context drawer close focus policy", () => {
  it("preserves the ordinary trigger restore policy by default", () => {
    expect(
      consumeContextDrawerCloseFocus(DEFAULT_CONTEXT_DRAWER_CLOSE_FOCUS),
    ).toEqual({
      preventTriggerRestore: false,
      nextPolicy: DEFAULT_CONTEXT_DRAWER_CLOSE_FOCUS,
    });
  });

  it("suppresses trigger restore exactly once after history selection", () => {
    const requested = requestSelectionCloseFocus();
    const firstClose = consumeContextDrawerCloseFocus(requested);

    expect(firstClose).toEqual({
      preventTriggerRestore: true,
      nextPolicy: DEFAULT_CONTEXT_DRAWER_CLOSE_FOCUS,
    });
    expect(consumeContextDrawerCloseFocus(firstClose.nextPolicy)).toEqual({
      preventTriggerRestore: false,
      nextPolicy: DEFAULT_CONTEXT_DRAWER_CLOSE_FOCUS,
    });
  });
});
