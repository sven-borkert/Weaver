"use client";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import type { MergeConflict } from "@weaver/core/tables/merge";
import { presentTableConflicts } from "~/lib/tables/presentation";
import type { TableColumn, TableRow } from "@weaver/core/tables/types";

type TableConflictDialogProps = {
  open: boolean;
  conflicts: readonly MergeConflict[];
  columns: readonly TableColumn[];
  rows: readonly TableRow[];
  headCommitSha: string;
  reloading: boolean;
  reloadError?: string;
  onKeepEditing: () => void;
  onReload: () => void;
  onExport: () => void;
};

export function TableConflictDialog({
  open,
  conflicts,
  columns,
  rows,
  headCommitSha,
  reloading,
  reloadError,
  onKeepEditing,
  onReload,
  onExport,
}: TableConflictDialogProps) {
  const sections = presentTableConflicts(conflicts, columns, rows);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !reloading) onKeepEditing();
      }}
    >
      <DialogContent showCloseButton={false} aria-busy={reloading}>
        <DialogHeader>
          <DialogTitle>This table changed elsewhere</DialogTitle>
          <DialogDescription>
            Your local draft is still here. The committed version is now at
            revision {headCommitSha.slice(0, 7)}. Export your draft before
            reloading, keep editing, or reload the committed version and discard
            your changes.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-72 flex-col gap-3 overflow-y-auto">
          {conflicts.length === 0 ? (
            <p className="text-text-2 text-[13px]">
              The previous version is unavailable, or the combined changes
              exceed a table limit. Reload the committed version to continue.
            </p>
          ) : null}
          {sections.map((section) => (
            <section
              key={section.kind}
              aria-labelledby={`conflict-${section.kind}`}
            >
              <h3
                id={`conflict-${section.kind}`}
                className="text-text m-0 text-[13px] font-semibold"
              >
                {section.heading}
              </h3>
              <ul className="text-text-2 mt-1 mb-0 flex list-disc flex-col gap-1 pl-5 text-[13px]">
                {section.items.map((item, index) => (
                  <li key={`${item}:${index}`}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        {reloadError ? (
          <p role="alert" className="text-danger m-0 text-[12px]">
            {reloadError}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onExport}>
            Export draft
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={reloading}
            onClick={onKeepEditing}
          >
            Keep editing
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={reloading}
            aria-busy={reloading}
            onClick={onReload}
          >
            {reloading ? "Reloading…" : "Reload committed version"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
