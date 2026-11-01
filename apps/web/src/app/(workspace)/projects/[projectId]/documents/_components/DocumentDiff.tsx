"use client";

import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { buildSideBySideRows, type DiffLine } from "~/lib/documents/diff-view";
import { cn } from "~/lib/utils";
import { api } from "~/trpc/react";
import { RestoreVersionDialog } from "./RestoreVersionDialog";

type DiffLayout = "inline" | "side-by-side";

type DocumentDiffProps = {
  projectId: string;
  documentId: string;
  fromSha: string;
  toSha: string;
  canEdit: boolean;
  onBack: () => void;
  onRestored: () => void;
};

export function DocumentDiff({
  projectId,
  documentId,
  fromSha,
  toSha,
  canEdit,
  onBack,
  onRestored,
}: DocumentDiffProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const wideEnoughForSideBySide = useWideDiffLayout();
  const [layout, setLayout] = useState<DiffLayout>("inline");
  const activeLayout = wideEnoughForSideBySide ? layout : "inline";
  const diffQuery = api.document.diff.useQuery({
    projectId,
    documentId,
    fromSha,
    toSha,
  });

  useEffect(() => {
    const focusTimer = window.setTimeout(() => headingRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, [fromSha, toSha]);

  return (
    <section aria-labelledby="document-diff-heading" className="min-h-full">
      <header className="border-line bg-surface sticky top-0 z-10 border-b px-6 py-4">
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Button type="button" variant="ghost" onClick={onBack}>
              <ArrowLeft data-icon="inline-start" />
              Back to document
            </Button>
            <div className="min-w-0">
              <h1
                ref={headingRef}
                id="document-diff-heading"
                tabIndex={-1}
                className="text-text m-0 text-[18px] font-semibold"
              >
                Version comparison
              </h1>
              <p className="text-text-3 mt-0.5 mb-0 text-[12px]">
                {fromSha.slice(0, 7)} compared with current
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup
              type="single"
              value={activeLayout}
              variant="outline"
              size="sm"
              spacing={0}
              aria-label="Diff layout"
              onValueChange={(value) => {
                if (value === "inline" || value === "side-by-side") {
                  setLayout(value);
                }
              }}
            >
              <ToggleGroupItem value="inline" aria-label="Inline diff">
                Inline
              </ToggleGroupItem>
              <ToggleGroupItem
                value="side-by-side"
                aria-label="Side-by-side diff"
                disabled={!wideEnoughForSideBySide}
              >
                Side by side
              </ToggleGroupItem>
            </ToggleGroup>
            <RestoreVersionDialog
              expectedHeadCommitSha={toSha}
              projectId={projectId}
              documentId={documentId}
              sha={fromSha}
              canEdit={canEdit}
              onRestored={onRestored}
            />
          </div>
        </div>
      </header>

      <div className="w-full p-6">
        {diffQuery.isLoading ? (
          <div role="status" aria-label="Comparing document versions">
            <span className="sr-only">Comparing document versions…</span>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="mt-2 h-28 w-full" />
            <Skeleton className="mt-2 h-20 w-4/5" />
          </div>
        ) : diffQuery.error ? (
          <div
            role="alert"
            className="border-danger-border bg-danger-bg rounded-[10px] border p-4"
          >
            <h2 className="text-danger m-0 text-[14px] font-semibold">
              Could not compare versions
            </h2>
            <p className="text-text-3 mt-1 mb-0 text-[13px]">
              Refresh the page or choose the version again.
            </p>
          </div>
        ) : diffQuery.data && "tooLarge" in diffQuery.data ? (
          <div className="border-info-border bg-info-bg rounded-[10px] border p-4">
            <h2 className="text-info m-0 text-[14px] font-semibold">
              Diff too large to display
            </h2>
            <p className="text-text-2 mt-1 mb-0 text-[13px]">
              Both versions are valid, but their changes are too large to
              compare here. You can still restore the selected version.
            </p>
          </div>
        ) : diffQuery.data && "lines" in diffQuery.data ? (
          activeLayout === "side-by-side" ? (
            <SideBySideDiff lines={diffQuery.data.lines} />
          ) : (
            <InlineDiff lines={diffQuery.data.lines} />
          )
        ) : null}
      </div>
    </section>
  );
}

function useWideDiffLayout(): boolean {
  const [wide, setWide] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return wide;
}

function InlineDiff({ lines }: { lines: DiffLine[] }) {
  return (
    <div
      aria-label="Inline document diff"
      className="border-line bg-surface overflow-hidden rounded-[10px] border font-mono text-[12px]"
    >
      {lines.map((line, index) => (
        <div
          key={`${index}:${line.type}`}
          className={cn(
            "grid grid-cols-[2rem_minmax(0,1fr)]",
            line.type === "add" && "bg-approved-bg",
            line.type === "del" && "bg-danger-bg",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "border-line-faint text-text-muted border-r px-2 py-0.5 text-center select-none",
              line.type === "add" && "text-approved",
              line.type === "del" && "text-danger",
            )}
          >
            {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
          </span>
          <span className="text-text min-w-0 px-3 py-0.5 break-words whitespace-pre-wrap">
            {line.text || "\u00a0"}
          </span>
        </div>
      ))}
    </div>
  );
}

function SideBySideDiff({ lines }: { lines: DiffLine[] }) {
  const rows = buildSideBySideRows(lines);

  return (
    <div
      role="table"
      aria-label="Side-by-side document diff"
      className="border-line bg-surface overflow-hidden rounded-[10px] border font-mono text-[12px]"
    >
      <div
        role="row"
        className="border-line bg-surface-2 text-text-2 grid grid-cols-2 border-b font-sans text-[12px] font-medium"
      >
        <div role="columnheader" className="border-line border-r px-3 py-2">
          Selected version
        </div>
        <div role="columnheader" className="px-3 py-2">
          Current version
        </div>
      </div>
      {rows.map((row, index) => (
        <div role="row" key={index} className="grid grid-cols-2">
          <DiffCell side="left" line={row.left} />
          <DiffCell side="right" line={row.right} />
        </div>
      ))}
    </div>
  );
}

function DiffCell({
  side,
  line,
}: {
  side: "left" | "right";
  line: DiffLine | null;
}) {
  return (
    <div
      role="cell"
      className={cn(
        "grid min-w-0 grid-cols-[2rem_minmax(0,1fr)]",
        side === "left" && "border-line border-r",
        line?.type === "del" && "bg-danger-bg",
        line?.type === "add" && "bg-approved-bg",
        !line && "bg-surface-2",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "border-line-faint text-text-muted border-r px-2 py-0.5 text-center select-none",
          line?.type === "del" && "text-danger",
          line?.type === "add" && "text-approved",
        )}
      >
        {line?.type === "del" ? "−" : line?.type === "add" ? "+" : " "}
      </span>
      <span className="text-text min-w-0 px-3 py-0.5 break-words whitespace-pre-wrap">
        {line?.text ?? "\u00a0"}
      </span>
    </div>
  );
}
