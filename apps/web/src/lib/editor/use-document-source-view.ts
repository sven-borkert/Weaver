"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type SetStateAction,
} from "react";

type SourceReturnPosition = {
  navigationKey: string | undefined;
  focus: HTMLElement | null;
  workspace: HTMLElement | null;
  scrollTop: number;
  scrollLeft: number;
};

export function useDocumentSourceView({
  articleRef,
  navigationKey,
  canShowFormatted = true,
}: {
  articleRef: RefObject<HTMLElement | null>;
  navigationKey?: string;
  canShowFormatted?: boolean;
}) {
  const [mode, setMode] = useState({ open: false, navigationKey });
  if (canShowFormatted && mode.navigationKey !== navigationKey)
    setMode({ open: false, navigationKey });
  const sourceOpen =
    mode.open && (!canShowFormatted || mode.navigationKey === navigationKey);
  const sourceRef = useRef<HTMLElement>(null);
  const sourceInputRef = useRef<HTMLTextAreaElement>(null);
  const returnPosition = useRef<SourceReturnPosition | null>(null);
  const transition = useRef<"open" | "close" | null>(null);

  const setSourceOpen = useCallback(
    (value: SetStateAction<boolean>) => {
      const open = typeof value === "function" ? value(sourceOpen) : value;
      if (open === sourceOpen || (!open && !canShowFormatted)) return;
      if (open) {
        const article = articleRef.current;
        const workspace =
          article?.closest<HTMLElement>(
            '[role="region"][aria-label="Document workspace"]',
          ) ?? null;
        const active = article?.ownerDocument.activeElement;
        const Element = article?.ownerDocument.defaultView?.HTMLElement;
        returnPosition.current = {
          navigationKey,
          focus: Element && active instanceof Element ? active : null,
          workspace,
          scrollTop: workspace?.scrollTop ?? 0,
          scrollLeft: workspace?.scrollLeft ?? 0,
        };
      }
      transition.current = open ? "open" : "close";
      setMode({ open, navigationKey });
    },
    [articleRef, navigationKey, sourceOpen, canShowFormatted],
  );

  useLayoutEffect(() => {
    const position = returnPosition.current;
    const action = transition.current;
    transition.current = null;
    if (position && position.navigationKey !== navigationKey) {
      returnPosition.current = null;
      return;
    }
    if (sourceOpen && action === "open") {
      if (position?.workspace) position.workspace.scrollTop = 0;
      sourceRef.current?.focus({ preventScroll: true });
    } else if (!sourceOpen && action === "close" && position) {
      const target = position.focus?.isConnected
        ? position.focus
        : position.workspace;
      if (target?.isConnected) target.focus({ preventScroll: true });
      if (position.workspace?.isConnected) {
        position.workspace.scrollTop = position.scrollTop;
        position.workspace.scrollLeft = position.scrollLeft;
      }
      returnPosition.current = null;
    }
  }, [navigationKey, sourceOpen]);

  return { sourceOpen, setSourceOpen, sourceRef, sourceInputRef };
}
