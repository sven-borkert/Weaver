"use client";

import {
  AllCommunityModule,
  type CellValueChangedEvent,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
  type SelectionChangedEvent,
} from "ag-grid-community";
import { AgGridProvider, AgGridReact } from "ag-grid-react";
import { useQueries } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { api } from "~/trpc/react";
import { useParams } from "next/navigation";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { AssistantMarkdown } from "~/components/assistant/AssistantMarkdown";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { commitPendingGridEdit } from "~/lib/tables/grid-edit";
import {
  coerceGridValue,
  toGridColumnDefs,
  toGridRows,
  type GridTableRow,
} from "~/lib/tables/grid";
import type {
  CellValue,
  TableColumn,
  TableRow,
} from "@weaver/core/tables/types";
import {
  BooleanCellRenderer,
  DateTimeCellEditor,
  DateTimeCellRenderer,
  DocumentCellEditor,
  DocumentCellRenderer,
  LongTextCellRenderer,
  MultiselectCellEditor,
  MultiselectCellRenderer,
  selectCellLabel,
  UrlCellRenderer,
} from "./TableCellEditors";
import { tableGridAccessibleName } from "./table-polish";
import { weaverTableTheme } from "./table-grid-theme";

type TableGridProps = {
  title: string;
  columns: TableColumn[];
  rows: TableRow[];
  canEdit: boolean;
  onCellChange: (change: {
    rowId: string;
    columnId: string;
    value: CellValue | undefined;
  }) => void;
  onSelectionChange: (rowIds: string[]) => void;
  onEditingChange: (editing: boolean) => void;
};

export type TableGridHandle = {
  commitPendingEdit(): Promise<void>;
};

const modules = [AllCommunityModule];
const components = {
  documentCellEditor: DocumentCellEditor,
  dateTimeCellEditor: DateTimeCellEditor,
  multiselectCellEditor: MultiselectCellEditor,
};
const INVALID_VALUE_REVERT_SOURCE = "weaver-invalid-value-revert";

export const TableGrid = forwardRef<TableGridHandle, TableGridProps>(
  function TableGrid(
    {
      title,
      columns,
      rows,
      canEdit,
      onCellChange,
      onSelectionChange,
      onEditingChange,
    },
    ref,
  ) {
    const { projectId = "" } = useParams<{ projectId: string }>();
    const utils = api.useUtils();
    const referenceInputs = useMemo(() => {
      const documentColumns = columns.filter(
        (column) => column.type === "document",
      );
      const ids = [
        ...new Set(
          rows.flatMap((row) =>
            documentColumns.flatMap((column) =>
              typeof row.cells[column.id] === "string"
                ? [row.cells[column.id] as string]
                : [],
            ),
          ),
        ),
      ].sort();
      const inputs: Array<{ projectId: string; ids: string[] }> = [];
      for (let offset = 0; offset < ids.length; offset += 25_000)
        inputs.push({ projectId, ids: ids.slice(offset, offset + 25_000) });
      return inputs;
    }, [columns, rows, projectId]);
    const resolvedReferences = useQueries({
      queries: referenceInputs.map((input) => ({
        queryKey: getQueryKey(api.document.resolveRefs, input, "query"),
        queryFn: () => utils.client.document.resolveRefs.query(input),
        enabled: Boolean(projectId),
      })),
      combine: (queries) => ({
        targets: queries.flatMap((query) =>
          (query.data ?? []).flatMap((target) =>
            target.exists && target.targetType === "document" ? [target] : [],
          ),
        ),
        loading: queries.some((query) => query.isLoading),
      }),
    });
    const references = useMemo(
      () =>
        new Map(
          resolvedReferences.targets.map((target) => [target.id, target]),
        ),
      [resolvedReferences.targets],
    );
    const referencesLoading = resolvedReferences.loading;
    const [longTextExpand, setLongTextExpand] = useState<{
      columnName: string;
      text: string;
    } | null>(null);
    const gridApiRef = useRef<GridApi<GridTableRow> | null>(null);
    const editingRef = useRef(false);
    const accessibleName = tableGridAccessibleName(title);
    const popupParent = typeof document === "undefined" ? null : document.body;
    const rowData = useMemo(() => toGridRows(rows), [rows]);
    const columnDefs = useMemo<ColDef<GridTableRow>[]>(
      () =>
        toGridColumnDefs(columns, canEdit).map((definition, index) => {
          const column = columns[index]!;
          switch (column.type) {
            case "select":
              return {
                ...definition,
                valueFormatter: ({ value }) => selectCellLabel(column, value),
              };
            case "boolean":
              return {
                ...definition,
                cellRenderer: BooleanCellRenderer,
                cellRendererParams: { columnName: column.name },
              };
            case "document":
              return {
                ...definition,
                cellEditorPopup: true,
                cellEditorPopupPosition: "under",
                cellEditorParams: { projectId },
                cellRenderer: DocumentCellRenderer,
                cellRendererParams: {
                  projectId,
                  canEdit,
                  references,
                  referencesLoading,
                },
              };
            case "datetime":
              return {
                ...definition,
                cellRenderer: DateTimeCellRenderer,
              };
            case "multiselect":
              return {
                ...definition,
                cellEditorPopupPosition: "under",
                cellRenderer: MultiselectCellRenderer,
                cellRendererParams: { column },
              };
            case "url":
              return {
                ...definition,
                cellRenderer: UrlCellRenderer,
              };
            case "longtext":
              return {
                ...definition,
                cellEditorPopupPosition: "under",
                cellRenderer: LongTextCellRenderer,
                cellRendererParams: {
                  columnName: column.name,
                  onExpand: (text: string) =>
                    setLongTextExpand({ columnName: column.name, text }),
                },
              };
            default:
              return definition;
          }
        }),
      [canEdit, columns, projectId, references, referencesLoading],
    );

    const handleCellValueChanged = useCallback(
      (event: CellValueChangedEvent<GridTableRow>) => {
        if (event.source === INVALID_VALUE_REVERT_SOURCE) return;
        const columnId = event.column.getColId();
        const column = columns.find((entry) => entry.id === columnId);
        if (!column) return;

        const result = coerceGridValue(column, event.newValue);
        if (!result.ok) {
          event.node.setDataValue(
            columnId,
            event.oldValue,
            INVALID_VALUE_REVERT_SOURCE,
          );
          return;
        }

        onCellChange({
          rowId: event.data.__rowId,
          columnId,
          value: result.value,
        });
      },
      [columns, onCellChange],
    );

    const handleSelectionChanged = useCallback(
      (event: SelectionChangedEvent<GridTableRow>) => {
        onSelectionChange(
          (event.selectedNodes ?? []).flatMap((node) =>
            node.data ? [node.data.__rowId] : [],
          ),
        );
      },
      [onSelectionChange],
    );

    useEffect(() => {
      gridApiRef.current?.setGridAriaProperty("label", accessibleName);
    }, [accessibleName]);

    const handleGridReady = useCallback(
      (event: GridReadyEvent<GridTableRow>) => {
        gridApiRef.current = event.api;
        event.api.setGridAriaProperty("label", accessibleName);
      },
      [accessibleName],
    );

    useImperativeHandle(
      ref,
      () => ({
        commitPendingEdit: () => {
          const api = gridApiRef.current;
          const waitForGridEvents = (callback: () => void) => {
            window.setTimeout(() => {
              window.requestAnimationFrame(() => callback());
            });
          };
          return commitPendingGridEdit(
            api,
            waitForGridEvents,
            editingRef.current,
          );
        },
      }),
      [],
    );

    return (
      <div className="min-h-72 min-w-0 flex-1 overflow-hidden">
        <AgGridProvider modules={modules}>
          <AgGridReact<GridTableRow>
            theme={weaverTableTheme}
            rowData={rowData}
            columnDefs={columnDefs}
            components={components}
            popupParent={popupParent}
            getRowId={({ data }) => data.__rowId}
            rowSelection={{ mode: "multiRow", enableClickSelection: false }}
            enableCellTextSelection
            ensureDomOrder
            stopEditingWhenCellsLoseFocus
            onCellValueChanged={handleCellValueChanged}
            onCellKeyDown={(event) => {
              const key = (event.event as KeyboardEvent | undefined)?.key;
              if (
                !canEdit ||
                editingRef.current ||
                (key !== "Delete" && key !== "Backspace") ||
                !event.data ||
                !("column" in event)
              )
                return;
              event.event?.preventDefault();
              onCellChange({
                rowId: event.data.__rowId,
                columnId: event.column.getColId(),
                value: undefined,
              });
            }}
            onCellEditingStarted={() => {
              editingRef.current = true;
              onEditingChange(true);
            }}
            onCellEditingStopped={() => {
              editingRef.current = false;
              onEditingChange(false);
            }}
            onSelectionChanged={handleSelectionChanged}
            onGridReady={handleGridReady}
            onGridPreDestroyed={() => {
              gridApiRef.current = null;
              editingRef.current = false;
              onEditingChange(false);
            }}
            suppressMovableColumns
            suppressRowDrag
          />
        </AgGridProvider>
        <Dialog
          open={longTextExpand !== null}
          onOpenChange={(open) => !open && setLongTextExpand(null)}
        >
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{longTextExpand?.columnName}</DialogTitle>
              <DialogDescription className="sr-only">
                Full text for {longTextExpand?.columnName}
              </DialogDescription>
            </DialogHeader>
            <div className="scrollarea max-h-[60vh] overflow-y-auto">
              <AssistantMarkdown text={longTextExpand?.text ?? ""} />
            </div>
            <details className="text-text-3 text-[12px]">
              <summary className="cursor-pointer">Raw text</summary>
              <pre className="text-text-2 mt-1 max-h-40 overflow-y-auto text-[12px] break-words whitespace-pre-wrap">
                {longTextExpand?.text}
              </pre>
            </details>
          </DialogContent>
        </Dialog>
      </div>
    );
  },
);
