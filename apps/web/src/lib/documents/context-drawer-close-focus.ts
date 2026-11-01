export type ContextDrawerCloseFocusPolicy =
  "restore-trigger" | "preserve-selection-focus";

export const DEFAULT_CONTEXT_DRAWER_CLOSE_FOCUS =
  "restore-trigger" satisfies ContextDrawerCloseFocusPolicy;

/** A drawer choice (history version, contents section) moves focus itself. */
export function requestSelectionCloseFocus(): ContextDrawerCloseFocusPolicy {
  return "preserve-selection-focus";
}

export function consumeContextDrawerCloseFocus(
  policy: ContextDrawerCloseFocusPolicy,
): {
  preventTriggerRestore: boolean;
  nextPolicy: ContextDrawerCloseFocusPolicy;
} {
  return {
    preventTriggerRestore: policy === "preserve-selection-focus",
    nextPolicy: DEFAULT_CONTEXT_DRAWER_CLOSE_FOCUS,
  };
}
