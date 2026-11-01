"use client";

import { ArrowLeft } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { presentTableDiff } from "~/lib/tables/presentation";
import type { TableColumn } from "@weaver/core/tables/types";
import { api } from "~/trpc/react";
import { RestoreTableVersionDialog } from "./RestoreTableVersionDialog";

export function TableDiff({
  projectId,
  tableId,
  fromSha,
  toSha,
  columns,
  canEdit,
  editAccessToken,
  restorePending,
  restoreError,
  onBack,
  onRestore,
}: {
  projectId: string;
  tableId: string;
  fromSha: string;
  toSha: string;
  columns: TableColumn[];
  canEdit: boolean;
  editAccessToken: object;
  restorePending: boolean;
  restoreError?: string;
  onBack: () => void;
  onRestore: () => void;
}) {
  const diffQuery = api.table.diff.useQuery({
    projectId,
    tableId,
    fromSha,
    toSha,
  });
  const sections =
    diffQuery.data && !("tooLarge" in diffQuery.data)
      ? presentTableDiff(diffQuery.data, columns)
      : [];

  return (
    <section aria-labelledby="table-diff-heading" className="min-h-full">
      <header className="border-line bg-surface sticky top-0 z-10 border-b px-4 py-4 sm:px-6">
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Button type="button" variant="ghost" onClick={onBack}>
              <ArrowLeft data-icon="inline-start" aria-hidden="true" />
              Back to table
            </Button>
            <div className="min-w-0">
              <h1
                id="table-diff-heading"
                className="text-text m-0 text-[18px] font-semibold"
              >
                Version comparison
              </h1>
              <p className="text-text-3 mt-0.5 mb-0 text-[12px]">
                {fromSha.slice(0, 7)} compared with current
              </p>
            </div>
          </div>
          <RestoreTableVersionDialog
            sha={fromSha}
            canEdit={canEdit}
            editAccessToken={editAccessToken}
            pending={restorePending}
            error={restoreError}
            onRestore={onRestore}
          />
        </div>
      </header>

      <div className="w-full p-4 sm:p-6">
        {diffQuery.isLoading ? (
          <div role="status" aria-label="Comparing table versions">
            <span className="sr-only">Comparing table versions…</span>
            <Skeleton className="h-20 w-full" />
            <Skeleton className="mt-3 h-28 w-full" />
            <Skeleton className="mt-3 h-20 w-full" />
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
              Return to history and choose the version again.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => void diffQuery.refetch()}
            >
              Retry comparison
            </Button>
          </div>
        ) : diffQuery.data && "tooLarge" in diffQuery.data ? (
          <div className="border-info-border bg-info-bg rounded-[10px] border p-4">
            <h2 className="text-info m-0 text-[14px] font-semibold">
              Diff too large to display
            </h2>
            <p className="text-text-2 mt-1 mb-0 text-[13px]">
              These versions are too large to compare, but their changes are too
              large to compare here. Restore is available only when the selected
              version is within the supported row and column limits.
            </p>
          </div>
        ) : sections.length === 0 ? (
          <div className="border-line bg-surface rounded-[10px] border p-4">
            <h2 className="text-text m-0 text-[14px] font-semibold">
              No changes to display
            </h2>
            <p className="text-text-3 mt-1 mb-0 text-[13px]">
              This version matches the current table content.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {sections.map((section) => (
              <section
                key={section.kind}
                aria-labelledby={`table-diff-${section.kind}`}
                className="border-line bg-surface overflow-hidden rounded-[10px] border"
              >
                <h2
                  id={`table-diff-${section.kind}`}
                  className="border-line bg-surface-2 text-text m-0 border-b px-4 py-2.5 text-[13px] font-semibold"
                >
                  {section.heading}
                </h2>
                <ul className="divide-line-faint m-0 flex list-none flex-col divide-y p-0">
                  {section.items.map((item, index) => (
                    <li
                      key={`${section.kind}:${index}`}
                      className="text-text-2 px-4 py-2.5 text-[13px]"
                    >
                      {item}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
