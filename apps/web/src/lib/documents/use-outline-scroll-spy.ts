"use client";

import { useEffect, useState } from "react";
import type { DocumentOutlineEntry } from "~/lib/editor/document-heading-anchors";
import { currentOutlineAnchor } from "./outline-scroll-spy";

/** Tracks the section scrolled to in the document canvas while `active`. */
export function useOutlineScrollSpy(
  outline: readonly DocumentOutlineEntry[],
  active: boolean,
): string | undefined {
  const [current, setCurrent] = useState<string>();

  useEffect(() => {
    if (!active) return;
    const canvas = document.querySelector<HTMLElement>(
      "[data-document-canvas]",
    );
    if (!canvas) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const view = canvas.getBoundingClientRect();
      const headings = outline.flatMap(({ anchor }) => {
        const element = document.getElementById(anchor);
        // Hidden headings (raw Markdown view) have no boxes.
        return element &&
          canvas.contains(element) &&
          element.getClientRects().length > 0
          ? [{ anchor, element }]
          : [];
      });
      const first = headings[0]?.element;
      // Jumps land a heading at its scroll margin below the sticky title.
      const margin = first
        ? Number.parseFloat(getComputedStyle(first).scrollMarginTop) || 0
        : 0;
      const scrollable = canvas.scrollHeight > canvas.clientHeight + 2;
      setCurrent(
        currentOutlineAnchor({
          headings: headings.map(({ anchor, element }) => ({
            anchor,
            top: element.getBoundingClientRect().top,
          })),
          readingLine: view.top + margin + 2,
          viewportBottom: view.bottom,
          atEnd:
            scrollable &&
            canvas.scrollTop + canvas.clientHeight >= canvas.scrollHeight - 2,
        }),
      );
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    schedule();
    canvas.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      canvas.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [active, outline]);

  return active ? current : undefined;
}
