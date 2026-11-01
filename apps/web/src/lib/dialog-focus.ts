type FocusTarget = Pick<HTMLElement, "focus" | "isConnected"> & {
  disabled?: boolean;
};

/** A disabled control silently refuses focus, so it must not block the fallback. */
function focusable(target: FocusTarget | null): boolean {
  return Boolean(target?.isConnected) && !target?.disabled;
}

export function focusDialogTarget(
  target: FocusTarget | null,
  fallback: FocusTarget | null = null,
  schedule: (callback: () => void) => void = (callback) => {
    window.requestAnimationFrame(callback);
  },
): void {
  schedule(() => {
    [target, fallback].find(focusable)?.focus();
  });
}
