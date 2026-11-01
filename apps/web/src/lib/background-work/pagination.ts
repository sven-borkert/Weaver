export function changeWorkFilters<T extends Record<string, unknown>>(
  state: T & { cursors: (string | null)[]; page: number },
  patch: Partial<Omit<T, "cursors" | "page">>,
): T & { cursors: (string | null)[]; page: number } {
  return { ...state, ...patch, cursors: [null], page: 0 };
}
