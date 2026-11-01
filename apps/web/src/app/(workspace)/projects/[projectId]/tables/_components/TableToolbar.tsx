"use client";

import {
  ChevronLeft,
  ChevronRight,
  Columns3,
  MoreHorizontal,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { useRef, type ReactNode, type RefObject } from "react";
import { z } from "zod";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { hasOptions, type TableColumn } from "@weaver/core/tables/types";
import { tableSelectionAnnouncement } from "./table-polish";

const titleSchema = z
  .string()
  .trim()
  .min(1, "Enter a title")
  .max(200, "Title must be at most 200 characters")
  .refine((value) => !/[\r\n]/.test(value), {
    message: "Title must be a single line",
  });

type TableToolbarProps = {
  title: string;
  dirty: boolean;
  canEdit: boolean;
  selectedRowCount: number;
  rowCount: number;
  columns: TableColumn[];
  busy: boolean;
  savePending: boolean;
  onTitleChange: (title: string) => void;
  onAddRow: () => void;
  onDeleteRows: (returnFocusTarget: HTMLElement | null) => void;
  onAddColumnRequest: (returnFocusTarget: HTMLElement | null) => void;
  onRenameColumnRequest: (
    column: TableColumn,
    returnFocusTarget: HTMLElement | null,
  ) => void;
  onRetypeColumnRequest: (
    column: TableColumn,
    returnFocusTarget: HTMLElement | null,
  ) => void;
  onOptionsColumnRequest: (
    column: TableColumn,
    returnFocusTarget: HTMLElement | null,
  ) => void;
  onDeleteColumnRequest: (
    column: TableColumn,
    returnFocusTarget: HTMLElement | null,
  ) => void;
  onMoveColumn: (columnId: string, direction: "left" | "right") => void;
  onSaveRequest: (returnFocusTarget: HTMLElement | null) => void;
  /** Visible from md: up; every role sees it, not just canEdit. */
  extraActions?: ReactNode;
  /** Icon-only counterpart of extraActions, visible below md:. */
  compactExtraActions?: ReactNode;
};

type ColumnActionsProps = Pick<
  TableToolbarProps,
  | "columns"
  | "busy"
  | "onRenameColumnRequest"
  | "onRetypeColumnRequest"
  | "onOptionsColumnRequest"
  | "onDeleteColumnRequest"
  | "onMoveColumn"
> & { returnFocusRef: RefObject<HTMLButtonElement | null> };

function ColumnActionMenus({
  columns,
  busy,
  onRenameColumnRequest,
  onRetypeColumnRequest,
  onOptionsColumnRequest,
  onDeleteColumnRequest,
  onMoveColumn,
  returnFocusRef,
}: ColumnActionsProps) {
  return columns.map((column, index) => (
    <DropdownMenuSub key={column.id}>
      <DropdownMenuSubTrigger disabled={busy}>
        {column.name}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-40">
        <DropdownMenuItem
          onSelect={() => onRenameColumnRequest(column, returnFocusRef.current)}
        >
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => onRetypeColumnRequest(column, returnFocusRef.current)}
        >
          Change type
        </DropdownMenuItem>
        {hasOptions(column.type) ? (
          <DropdownMenuItem
            onSelect={() =>
              onOptionsColumnRequest(column, returnFocusRef.current)
            }
          >
            Edit options
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={index === 0}
          onSelect={() => onMoveColumn(column.id, "left")}
        >
          <ChevronLeft />
          Move left
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={index === columns.length - 1}
          onSelect={() => onMoveColumn(column.id, "right")}
        >
          <ChevronRight />
          Move right
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => onDeleteColumnRequest(column, returnFocusRef.current)}
        >
          <Trash2 />
          Delete column
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  ));
}

export function TableToolbar({
  title,
  dirty,
  canEdit,
  selectedRowCount,
  rowCount,
  columns,
  busy,
  savePending,
  onTitleChange,
  onAddRow,
  onDeleteRows,
  onAddColumnRequest,
  onRenameColumnRequest,
  onRetypeColumnRequest,
  onOptionsColumnRequest,
  onDeleteColumnRequest,
  onMoveColumn,
  onSaveRequest,
  extraActions,
  compactExtraActions,
}: TableToolbarProps) {
  const desktopColumnActionsTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileEditingActionsTriggerRef = useRef<HTMLButtonElement>(null);
  const saveTriggerRef = useRef<HTMLButtonElement>(null);
  const titleResult = titleSchema.safeParse(title);
  const disabled = busy || savePending;
  const deleteRowsLabel =
    selectedRowCount === 1 ? "Delete selected row" : "Delete selected rows";
  const columnActions = {
    columns,
    busy: disabled,
    onRenameColumnRequest,
    onRetypeColumnRequest,
    onOptionsColumnRequest,
    onDeleteColumnRequest,
    onMoveColumn,
  };

  return (
    <header
      className="border-line flex flex-col gap-3 border-b px-4 py-3 sm:px-6"
      aria-busy={savePending}
    >
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {tableSelectionAnnouncement(selectedRowCount)}
      </span>
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          {canEdit ? (
            <>
              <Input
                value={title}
                onChange={(event) => onTitleChange(event.target.value)}
                onBlur={() => {
                  const trimmed = title.trim();
                  if (trimmed !== title) onTitleChange(trimmed);
                }}
                aria-label="Table title"
                aria-invalid={!titleResult.success || undefined}
                aria-describedby={
                  titleResult.success ? undefined : "table-title-error"
                }
                disabled={disabled}
                className="h-8 max-w-xl text-[18px] font-semibold"
              />
              {!titleResult.success ? (
                <p
                  id="table-title-error"
                  role="alert"
                  className="text-danger mt-1 mb-0 text-[12px]"
                >
                  {titleResult.error.issues[0]?.message}
                </p>
              ) : null}
            </>
          ) : (
            <h1 className="text-text m-0 text-[20px] font-semibold break-words">
              {title}
            </h1>
          )}
          <p className="text-text-3 mt-1 mb-0 text-[13px]">
            {rowCount} row{rowCount === 1 ? "" : "s"} · {columns.length} column
            {columns.length === 1 ? "" : "s"}
            {canEdit ? (
              <> · {dirty ? "Unsaved changes" : "All changes saved"}</>
            ) : null}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <div className="hidden items-center gap-2 md:flex">
            {extraActions}
          </div>
          <div className="md:hidden">{compactExtraActions}</div>
          {canEdit ? (
            <>
              <div className="hidden items-center gap-2 md:flex">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled || rowCount >= 10_000}
                  onClick={onAddRow}
                >
                  <Plus data-icon="inline-start" />
                  Add row
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled || selectedRowCount === 0}
                  onClick={(event) => onDeleteRows(event.currentTarget)}
                >
                  <Trash2 data-icon="inline-start" />
                  Delete selected
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled || columns.length >= 100}
                  onClick={(event) => onAddColumnRequest(event.currentTarget)}
                >
                  <Columns3 data-icon="inline-start" />
                  Add column
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      ref={desktopColumnActionsTriggerRef}
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={disabled || columns.length === 0}
                    >
                      Column actions
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-44">
                    <DropdownMenuLabel>Choose a column</DropdownMenuLabel>
                    <ColumnActionMenus
                      {...columnActions}
                      returnFocusRef={desktopColumnActionsTriggerRef}
                    />
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    ref={mobileEditingActionsTriggerRef}
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    className="md:hidden"
                    disabled={disabled}
                    aria-label="Table editing actions"
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-48">
                  <DropdownMenuItem
                    disabled={rowCount >= 10_000}
                    onSelect={onAddRow}
                  >
                    <Plus />
                    Add row
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={selectedRowCount === 0}
                    onSelect={() =>
                      onDeleteRows(mobileEditingActionsTriggerRef.current)
                    }
                  >
                    <Trash2 />
                    {deleteRowsLabel}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={columns.length >= 100}
                    onSelect={() =>
                      onAddColumnRequest(mobileEditingActionsTriggerRef.current)
                    }
                  >
                    <Columns3 />
                    Add column
                  </DropdownMenuItem>
                  {columns.length > 0 ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>Column actions</DropdownMenuLabel>
                      <ColumnActionMenus
                        {...columnActions}
                        returnFocusRef={mobileEditingActionsTriggerRef}
                      />
                    </>
                  ) : null}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={!dirty || !titleResult.success}
                    onSelect={() =>
                      onSaveRequest(mobileEditingActionsTriggerRef.current)
                    }
                  >
                    <Save />
                    Save
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button
                ref={saveTriggerRef}
                type="button"
                size="sm"
                disabled={disabled || !dirty || !titleResult.success}
                onClick={() => onSaveRequest(saveTriggerRef.current)}
              >
                <Save data-icon="inline-start" />
                {savePending ? "Saving…" : "Save"}
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}
