"use client";

import { useEffect, useEffectEvent, type RefObject } from "react";
import {
  classifyDocumentShortcut,
  type DocumentShortcutContext,
} from "./document-shortcuts";

export function useDocumentViewShortcuts({
  articleRef,
  titleRef,
  sourceRef,
  blocked = false,
  onToggleSource,
}: {
  articleRef: RefObject<HTMLElement | null>;
  titleRef?: RefObject<HTMLElement | null>;
  sourceRef?: RefObject<HTMLElement | null>;
  blocked?: boolean;
  onToggleSource: () => void;
}) {
  const keyDown = useEffectEvent((event: KeyboardEvent) => {
    const article = articleRef.current;
    if (blocked || !article) return;
    const Element = article.ownerDocument.defaultView?.HTMLElement;
    const target = event.target;
    if (!Element || !(target instanceof Element)) return;
    let context: DocumentShortcutContext = "document";
    if (target.closest("[role='dialog'],[role='alertdialog'],[role='menu']")) {
      context = "overlay";
    } else if (sourceRef?.current?.contains(target)) {
      context = "source";
    } else if (target === titleRef?.current) {
      context = "title";
    } else if (target.closest("input,textarea,select")) {
      context = "unrelated-input";
    } else if (!article.contains(target) && target.isContentEditable) {
      return;
    }
    const action = classifyDocumentShortcut(event, context);
    if (action !== "toggle-source") return;
    event.preventDefault();
    onToggleSource();
  });

  useEffect(() => {
    const owner = articleRef.current?.ownerDocument;
    if (!owner) return;
    owner.addEventListener("keydown", keyDown);
    return () => owner.removeEventListener("keydown", keyDown);
  }, [articleRef]);
}
