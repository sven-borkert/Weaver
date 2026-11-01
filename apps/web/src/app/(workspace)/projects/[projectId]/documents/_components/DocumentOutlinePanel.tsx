"use client";

import type { JSONContent } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { useEffect, useRef } from "react";

import { revealScrollTop } from "~/lib/documents/outline-scroll-spy";
import { useDocumentOutline } from "~/lib/documents/use-document-outline";
import { useOutlineScrollSpy } from "~/lib/documents/use-outline-scroll-spy";
import type { DocumentOutlineEntry } from "~/lib/editor/document-heading-anchors";
import { cn } from "~/lib/utils";

const levelIndent = ["pl-2", "pl-5", "pl-8", "pl-11", "pl-14", "pl-17"];

export function DocumentOutlineList({
  outline,
  current,
  navigable,
  onSelect,
}: {
  outline: readonly DocumentOutlineEntry[];
  current?: string;
  navigable: boolean;
  onSelect: (anchor: string) => void;
}) {
  if (outline.length === 0)
    return (
      <p className="text-text-3 m-0 p-3 py-6 text-center text-[12px]">
        This document has no headings.
      </p>
    );
  const topLevel = Math.min(...outline.map((entry) => entry.level));
  return (
    <nav aria-label="Table of contents" className="p-3">
      {navigable ? null : (
        <p className="text-text-3 mt-0 mb-2 text-[12px]">
          Return to the document to jump to a section.
        </p>
      )}
      <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
        {outline.map((entry) => {
          const isCurrent = entry.anchor === current;
          return (
            <li key={entry.anchor}>
              <button
                type="button"
                disabled={!navigable}
                aria-current={isCurrent ? "location" : undefined}
                title={entry.text}
                data-outline-anchor={entry.anchor}
                onClick={() => onSelect(entry.anchor)}
                className={cn(
                  "text-text-2 hover:bg-hover focus-visible:ring-brand/50 block w-full truncate rounded-[6px] border-l-2 border-transparent py-1 pr-2 text-left text-[12px] leading-5 outline-none focus-visible:ring-3 disabled:cursor-default disabled:hover:bg-transparent pointer-coarse:py-2",
                  levelIndent[Math.min(entry.level - topLevel, 5)],
                  entry.level === topLevel && "text-text font-medium",
                  isCurrent && "border-brand bg-brand-bg text-brand",
                )}
              >
                {entry.text}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function DocumentOutlinePanel({
  editor,
  contentJson,
  active,
  navigable,
  onSelect,
}: {
  editor: Editor | null | undefined;
  contentJson: JSONContent;
  /** The tab is visible; only then does the panel follow scrolling. */
  active: boolean;
  navigable: boolean;
  onSelect: (anchor: string) => void;
}) {
  const outline = useDocumentOutline(editor, contentJson);
  const current = useOutlineScrollSpy(outline, active && navigable);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!current) return;
    const entry = panelRef.current?.querySelector<HTMLElement>(
      `[data-outline-anchor="${CSS.escape(current)}"]`,
    );
    const container = entry?.closest<HTMLElement>("[data-context-rail-scroll]");
    if (!entry || !container) return;
    const view = container.getBoundingClientRect();
    const item = entry.getBoundingClientRect();
    const scrollTop = revealScrollTop({
      scrollTop: container.scrollTop,
      viewTop: view.top,
      viewBottom: view.bottom,
      itemTop: item.top,
      itemBottom: item.bottom,
    });
    if (scrollTop !== undefined) container.scrollTop = scrollTop;
  }, [current]);

  return (
    <div ref={panelRef}>
      <DocumentOutlineList
        outline={outline}
        current={current}
        navigable={navigable}
        onSelect={onSelect}
      />
    </div>
  );
}
