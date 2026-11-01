"use client";

import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { focusDialogTarget } from "~/lib/dialog-focus";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  buildImportRows,
  filterImportRows,
  importButtonLabel,
  importPayload,
  importResultSummary,
  initialImportSelection,
  isRowSelectable,
  selectionForUpdateExisting,
  toggleVisibleSelection,
} from "./importModels";
import { CAPABILITY_LABELS, SOURCE_LABELS } from "./llmSchemas";

type DiscoveredModel = NonNullable<
  RouterOutputs["llm"]["testConnection"]["models"]
>[number];
type ImportResult = RouterOutputs["llm"]["importModels"];

export function ImportModelsDialog({
  open,
  onOpenChange,
  connection,
  discovered,
  declaredProviderModelIds,
  returnFocusRef,
  fallbackFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: { id: string; name: string };
  discovered: DiscoveredModel[];
  declaredProviderModelIds: string[];
  returnFocusRef: RefObject<HTMLElement | null>;
  fallbackFocusRef: RefObject<HTMLElement | null>;
}) {
  const utils = api.useUtils();
  const rows = useMemo(
    () => buildImportRows(discovered, declaredProviderModelIds),
    [discovered, declaredProviderModelIds],
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(() =>
    initialImportSelection(rows),
  );
  const [filter, setFilter] = useState("");
  const [updateExisting, setUpdateExisting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  const visibleRows = useMemo(
    () => filterImportRows(rows, filter),
    [rows, filter],
  );
  const selectableVisible = visibleRows.filter((row) =>
    isRowSelectable(row, updateExisting),
  );
  const selectedVisibleCount = selectableVisible.filter((row) =>
    selected.has(row.providerModelId),
  ).length;
  const allVisibleSelected =
    selectableVisible.length > 0 &&
    selectedVisibleCount === selectableVisible.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const declaredCount = rows.filter((row) => row.declared).length;

  useEffect(() => {
    if (selectAllRef.current)
      selectAllRef.current.indeterminate = someVisibleSelected;
  }, [someVisibleSelected]);

  const importModels = api.llm.importModels.useMutation({
    onSuccess: (imported) => {
      toast.success(importResultSummary(imported));
      void utils.llm.overview.invalidate();
      if (imported.skipped.length === 0) onOpenChange(false);
      else setResult(imported);
    },
    onError: (error) => toast.error(error.message || "Could not import models"),
  });
  const pending = importModels.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (pending) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="flex max-h-[calc(100vh-2rem)] flex-col sm:max-w-3xl"
        showCloseButton={!pending}
        aria-busy={pending || undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusDialogTarget(returnFocusRef.current, fallbackFocusRef.current);
        }}
      >
        <DialogHeader>
          <DialogTitle>Import models</DialogTitle>
          <DialogDescription>
            {result
              ? `Import finished for “${connection.name}”.`
              : `Models discovered on “${connection.name}”. New models are preselected; models that are already declared only change when you choose to update their limits.`}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <>
            <p role="status" className="text-text m-0 text-[13px]">
              Created {result.created}, updated {result.updated}, skipped{" "}
              {result.skipped.length}.
            </p>
            <ul className="border-line m-0 max-h-[50vh] list-none overflow-y-auto rounded-lg border p-2 text-[12px]">
              {result.skipped.map((item) => (
                <li key={item.providerModelId} className="py-1">
                  <code className="text-text">{item.providerModelId}</code>
                  <span className="text-text-3"> — {item.reason}</span>
                </li>
              ))}
            </ul>
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <Input
                aria-label="Filter models"
                placeholder="Filter by id or name"
                autoFocus
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              <p aria-live="polite" className="text-text-3 m-0 text-[12px]">
                {visibleRows.length} of {rows.length} models shown ·{" "}
                {selected.size} selected
              </p>
            </div>

            <div className="border-line max-h-[50vh] min-h-0 overflow-y-auto rounded-lg border">
              {visibleRows.length === 0 ? (
                <p className="text-text-3 m-0 p-3 text-[12px]">
                  {rows.length === 0
                    ? "No models were discovered."
                    : `No models match “${filter.trim()}”.`}
                </p>
              ) : (
                <Table>
                  <TableCaption className="sr-only">
                    Discovered models
                  </TableCaption>
                  <TableHeader className="bg-popover sticky top-0">
                    <TableRow>
                      <TableHead className="w-8">
                        <input
                          ref={selectAllRef}
                          type="checkbox"
                          aria-label="Select all visible models"
                          checked={allVisibleSelected}
                          disabled={selectableVisible.length === 0 || pending}
                          onChange={(event) =>
                            setSelected(
                              toggleVisibleSelection(
                                selected,
                                visibleRows,
                                updateExisting,
                                event.target.checked,
                              ),
                            )
                          }
                        />
                      </TableHead>
                      <TableHead>Model</TableHead>
                      <TableHead>Capabilities</TableHead>
                      <TableHead>Context</TableHead>
                      <TableHead>Max output</TableHead>
                      <TableHead>Dimensions</TableHead>
                      <TableHead>Source</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleRows.map((row) => (
                      <TableRow key={row.providerModelId}>
                        <TableCell>
                          <input
                            type="checkbox"
                            aria-label={`Import ${row.providerModelId}`}
                            aria-describedby={
                              row.declared
                                ? "llm-import-declared-hint"
                                : undefined
                            }
                            checked={selected.has(row.providerModelId)}
                            disabled={
                              !isRowSelectable(row, updateExisting) || pending
                            }
                            onChange={(event) =>
                              setSelected(
                                toggleVisibleSelection(
                                  selected,
                                  [row],
                                  updateExisting,
                                  event.target.checked,
                                ),
                              )
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <div className="text-text text-[13px] font-medium">
                            {row.displayName}
                            {row.declared ? (
                              <Badge variant="outline" className="ml-2">
                                Declared
                              </Badge>
                            ) : null}
                          </div>
                          <code className="text-text-3 text-[12px]">
                            {row.providerModelId}
                          </code>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {row.capabilities.length === 0 ? (
                              <Badge variant="outline">Not supported</Badge>
                            ) : null}
                            {row.capabilities.map((capability) => (
                              <Badge key={capability} variant="secondary">
                                {CAPABILITY_LABELS[capability]}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="text-text-3 text-[12px]">
                          {row.contextWindow ?? "—"}
                        </TableCell>
                        <TableCell className="text-text-3 text-[12px]">
                          {row.maxOutputTokens ?? "—"}
                        </TableCell>
                        <TableCell className="text-text-3 text-[12px]">
                          {row.embeddingDimensions ?? "—"}
                        </TableCell>
                        <TableCell className="text-text-3 text-[11px]">
                          {SOURCE_LABELS[row.source]}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>

            <label className="text-text flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={updateExisting}
                disabled={pending}
                onChange={(event) => {
                  setUpdateExisting(event.target.checked);
                  setSelected(
                    selectionForUpdateExisting(
                      selected,
                      rows,
                      event.target.checked,
                    ),
                  );
                }}
              />
              Update limits of already declared models
            </label>
            <p
              id="llm-import-declared-hint"
              className="text-text-3 m-0 text-[12px]"
            >
              {declaredCount === 0
                ? "None of the discovered models are declared yet."
                : updateExisting
                  ? `${declaredCount} already declared; their context and output limits will be refreshed.`
                  : `${declaredCount} already declared; check the option above to refresh their limits.`}
            </p>

            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={pending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="button"
                disabled={pending || selected.size === 0}
                onClick={() =>
                  importModels.mutate({
                    connectionId: connection.id,
                    updateExisting,
                    models: importPayload(rows, selected),
                  })
                }
              >
                {pending ? "Importing…" : importButtonLabel(selected.size)}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
