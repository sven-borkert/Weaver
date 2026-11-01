"use client";

import { useState } from "react";
import { Button } from "~/components/ui/button";
import { truncationNote } from "~/lib/assistant/proposalPreview";
import type { DiffLine } from "~/lib/documents/diff-view";
import { cn } from "~/lib/utils";

const COLLAPSED_LINES = 40;

/** A panel-width echo of DocumentDiff.tsx's InlineDiff, bounded for a card. */
export function DocumentDiffPreview({
  lines,
  truncated,
}: {
  lines: DiffLine[];
  truncated: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const note = truncationNote(lines.length, truncated);
  const shown = expanded ? lines : lines.slice(0, COLLAPSED_LINES);
  const hidden = lines.length - shown.length;

  return (
    <div className="border-line bg-surface overflow-hidden rounded-md border">
      {lines.length === 0 ? (
        <p className="text-text-muted m-0 px-2 py-1.5 text-[12px]">
          No text changes
        </p>
      ) : (
        <div className="scrollarea max-h-80 overflow-auto font-mono text-[12px]">
          {shown.map((line, index) => (
            <div
              key={`${index}:${line.type}`}
              data-line-type={line.type}
              className={cn(
                "grid grid-cols-[1.25rem_minmax(0,1fr)]",
                line.type === "add" && "bg-approved-bg",
                line.type === "del" && "bg-danger-bg",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "border-line-faint text-text-muted border-r px-1 text-center select-none",
                  line.type === "add" && "text-approved",
                  line.type === "del" && "text-danger",
                )}
              >
                {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
              </span>
              <span className="text-text min-w-0 px-2 break-words whitespace-pre-wrap">
                {line.text || " "}
              </span>
            </div>
          ))}
        </div>
      )}
      {hidden > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="border-line w-full rounded-none border-t text-[12px]"
          onClick={() => setExpanded(true)}
        >
          Show all {lines.length.toLocaleString("en-US")} lines
        </Button>
      ) : null}
      {note ? (
        <p className="text-text-muted border-line m-0 border-t px-2 py-1 text-[11px]">
          {note}
        </p>
      ) : null}
    </div>
  );
}
