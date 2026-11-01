export type ReferencePickerPresentation =
  "loading" | "error" | "empty" | "results";

export type ReferenceTargetType = "document" | "table";

export type ReferencePickerState = {
  activeType: ReferenceTargetType;
  activeIndex: number;
  queries: Record<ReferenceTargetType, string>;
};

type ReferencePickerResultState<T> = {
  items: T[];
  isLoading: boolean;
  hasError: boolean;
};

type ReferencePickerResults<T> = Record<
  ReferenceTargetType,
  ReferencePickerResultState<T>
>;

export function resolveReferencePickerPresentation({
  itemCount,
  isLoading,
  hasError,
}: {
  itemCount: number;
  isLoading: boolean;
  hasError: boolean;
}): ReferencePickerPresentation {
  if (itemCount > 0) return "results";
  if (isLoading) return "loading";
  if (hasError) return "error";
  return "empty";
}

export function referencePickerTabSemantics(
  targetType: ReferenceTargetType,
  baseId: string,
) {
  const plural = targetType === "document" ? "documents" : "tables";

  return {
    comboboxId: `${baseId}-${targetType}-search`,
    listboxId: `${baseId}-${targetType}-results`,
    searchLabel: `Search ${plural}`,
    matchingLabel: `Matching ${plural}`,
  };
}

export function switchReferenceTargetType(
  state: ReferencePickerState,
  activeType: ReferenceTargetType,
): ReferencePickerState {
  return { ...state, activeType, activeIndex: 0 };
}

export function updateActiveReferenceQuery(
  state: ReferencePickerState,
  query: string,
): ReferencePickerState {
  return {
    ...state,
    activeIndex: 0,
    queries: { ...state.queries, [state.activeType]: query },
  };
}

export function activeReferencePickerView<T>(
  state: ReferencePickerState,
  results: ReferencePickerResults<T>,
) {
  const activeResults = results[state.activeType];
  const activeIndex = activeResults.items.length
    ? Math.min(state.activeIndex, activeResults.items.length - 1)
    : 0;

  return {
    targetType: state.activeType,
    query: state.queries[state.activeType],
    items: activeResults.items,
    activeIndex,
    presentation: resolveReferencePickerPresentation({
      itemCount: activeResults.items.length,
      isLoading: activeResults.isLoading,
      hasError: activeResults.hasError,
    }),
    hasError: activeResults.hasError,
  };
}
