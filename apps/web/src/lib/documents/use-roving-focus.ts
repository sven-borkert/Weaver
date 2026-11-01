import { useCallback, useRef, useState, type KeyboardEvent } from "react";

type Options = {
  count: number;
  /** Items per row in a grid; 1 for a vertical list. Resolved at keydown time when a function. */
  columns: number | (() => number);
  onActivate: (index: number) => void;
  onNavigateUp: () => void;
};

/** One tab stop for a list/grid of items: arrows move, Enter opens, Backspace/Alt+Up go to the parent. */
export function useRovingFocus({
  count,
  columns,
  onActivate,
  onNavigateUp,
}: Options) {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);

  const focusIndex = useCallback(
    (index: number) => {
      const next = Math.max(0, Math.min(count - 1, index));
      setFocusedIndex(next);
      itemRefs.current[next]?.focus();
    },
    [count],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // A nested control (e.g. a row's "…" menu trigger) also bubbles its keydown here; only roving items should drive navigation.
    if (!itemRefs.current.includes(event.target as HTMLElement)) return;
    if (
      event.key === "Backspace" ||
      (event.altKey && event.key === "ArrowUp")
    ) {
      event.preventDefault();
      onNavigateUp();
      return;
    }
    const cols = typeof columns === "function" ? columns() : columns;
    const moves: Record<string, number> = {
      ArrowDown: cols,
      ArrowUp: -cols,
      ArrowRight: cols > 1 ? 1 : 0,
      ArrowLeft: cols > 1 ? -1 : 0,
    };
    if (!event.altKey && event.key in moves && moves[event.key] !== 0) {
      event.preventDefault();
      focusIndex(focusedIndex + moves[event.key]!);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusIndex(count - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      onActivate(focusedIndex);
    }
  };

  const itemProps = (index: number) => ({
    ref: (element: HTMLElement | null) => {
      itemRefs.current[index] = element;
    },
    tabIndex: index === Math.min(focusedIndex, Math.max(0, count - 1)) ? 0 : -1,
    onFocus: () => setFocusedIndex(index),
  });

  return { onKeyDown, itemProps, focusedIndex };
}
