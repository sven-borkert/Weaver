"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { visibleToolbarGroups } from "./toolbar-overflow";

export const TOOLBAR_GROUP_SELECTOR = ":scope > [data-toolbar-group]";

type OverflowState = { key: string; visible: number; pass: number };

const canObserve = () => typeof ResizeObserver !== "undefined";

/** Counts the groups of a fixed-height wrapping row that stay on its first line. */
export function useToolbarOverflow(groupKey: string) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<OverflowState>({
    key: groupKey,
    visible: Number.POSITIVE_INFINITY,
    pass: 0,
  });
  // New groups are measured from the full, More-less row, never a stale count.
  if (state.key !== groupKey)
    setState({
      key: groupKey,
      visible: Number.POSITIVE_INFINITY,
      pass: state.pass + 1,
    });
  const measure = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const groups = Array.from(
      row.querySelectorAll<HTMLElement>(TOOLBAR_GROUP_SELECTOR),
    );
    const visible = visibleToolbarGroups(
      groups.map((group) => ({
        top: group.offsetTop,
        right: group.offsetLeft + group.offsetWidth,
      })),
      row.clientWidth,
    );
    setState((current) =>
      current.visible === visible ? current : { ...current, visible },
    );
  }, []);
  const remeasure = useCallback(
    () =>
      setState((current) => ({
        ...current,
        visible: Number.POSITIVE_INFINITY,
        pass: current.pass + 1,
      })),
    [],
  );
  useLayoutEffect(() => {
    if (canObserve()) measure();
  }, [state.key, state.pass, measure]);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || !canObserve()) return;
    const widths = new WeakMap<Element, number>();
    const observer = new ResizeObserver((entries) => {
      let roomer = false;
      for (const entry of entries) {
        const width = entry.contentRect.width;
        const previous = widths.get(entry.target);
        widths.set(entry.target, width);
        if (previous === undefined) continue;
        // Only a wider row or a narrower group can let hidden groups back in.
        if (entry.target === row ? width > previous : width < previous)
          roomer = true;
      }
      if (roomer) remeasure();
      else measure();
    });
    observer.observe(row);
    for (const group of row.querySelectorAll(TOOLBAR_GROUP_SELECTOR))
      observer.observe(group);
    return () => observer.disconnect();
  }, [state.key, measure, remeasure]);
  return { rowRef, visible: state.visible };
}
