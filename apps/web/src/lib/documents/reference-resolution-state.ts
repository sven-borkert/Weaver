export function referenceResolutionState<T>(
  targets: T[] | undefined,
  error: unknown,
): { targets: T[] | undefined; warning: string | null } {
  if (!error) return { targets, warning: null };
  if (targets) {
    return {
      targets,
      warning: "References could not be refreshed. Showing cached results.",
    };
  }
  return {
    targets,
    warning:
      "References could not be resolved. Stored labels are shown instead.",
  };
}
