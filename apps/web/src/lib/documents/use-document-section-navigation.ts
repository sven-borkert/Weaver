"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import {
  documentSectionNavigationKey,
  resolveDocumentSectionFeedback,
  resolveDocumentSectionTarget,
  sectionScrollBehavior,
  sectionScrollBlock,
  startDocumentSectionHighlight,
  type DocumentSectionAnnouncement,
  type DocumentSectionNavigation,
} from "./section-navigation";

export function useDocumentSectionNavigation({
  documentId,
  currentSourceSha,
  sectionNavigation,
  articleRef,
  titleRef,
  editable = false,
  ready = true,
  highlightSection,
}: {
  documentId: string;
  currentSourceSha: string;
  sectionNavigation?: DocumentSectionNavigation;
  articleRef: RefObject<HTMLElement | null>;
  titleRef: RefObject<HTMLHeadingElement | null>;
  editable?: boolean;
  ready?: boolean;
  highlightSection?: (section: string | null) => void;
}) {
  const lastHandledNavigationKey = useRef<string | undefined>(undefined);
  const [sectionAnnouncement, setSectionAnnouncement] =
    useState<DocumentSectionAnnouncement>();
  const [sectionHighlight, setSectionHighlight] = useState<{
    navigationKey: string;
    target: HTMLElement;
  }>();
  const sectionNavigationKey = sectionNavigation
    ? documentSectionNavigationKey(documentId, sectionNavigation)
    : undefined;

  useEffect(() => {
    if (!ready) return;
    if (!sectionNavigation || !sectionNavigationKey) {
      lastHandledNavigationKey.current = undefined;
      const frame = window.requestAnimationFrame(() => {
        setSectionAnnouncement(undefined);
        setSectionHighlight(undefined);
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (lastHandledNavigationKey.current === sectionNavigationKey) return;
    const target = window.document.getElementById(sectionNavigation.section);
    const sectionTarget =
      target instanceof HTMLElement && articleRef.current?.contains(target)
        ? target
        : null;
    const decision = resolveDocumentSectionTarget({
      requested: sectionNavigation,
      currentSourceSha,
      targetExists: Boolean(sectionTarget),
    });
    const scrollTarget =
      decision.target === "section" ? sectionTarget : titleRef.current;
    const focusTarget = editable ? titleRef.current : scrollTarget;
    const feedback = resolveDocumentSectionFeedback({
      navigationKey: sectionNavigationKey,
      target: decision.target,
    });
    const frame = window.requestAnimationFrame(() => {
      scrollTarget?.scrollIntoView({
        behavior: sectionScrollBehavior(
          window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        ),
        block: sectionScrollBlock(sectionNavigation),
      });
      focusTarget?.focus({ preventScroll: true });
      lastHandledNavigationKey.current = feedback.handledNavigationKey;
      setSectionAnnouncement(feedback.announcement);
      setSectionHighlight(
        decision.target === "section" && sectionTarget
          ? { navigationKey: sectionNavigationKey, target: sectionTarget }
          : undefined,
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    articleRef,
    currentSourceSha,
    editable,
    ready,
    sectionNavigation,
    sectionNavigationKey,
    titleRef,
  ]);

  useEffect(() => {
    if (
      !sectionHighlight ||
      sectionHighlight.navigationKey !== sectionNavigationKey
    )
      return;
    return startDocumentSectionHighlight(
      highlightSection
        ? {
            setAttribute: () => highlightSection(sectionHighlight.target.id),
            removeAttribute: () => highlightSection(null),
          }
        : sectionHighlight.target,
      window,
    );
  }, [highlightSection, sectionHighlight, sectionNavigationKey]);

  return { sectionAnnouncement, sectionNavigationKey };
}
