"use client";

import type { CellValue } from "@weaver/core/tables/types";
import { isValidUrlCell } from "@weaver/core/tables/validation";
import { keepPreviousData } from "@tanstack/react-query";
import { BookOpen, Maximize2, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import type {
  CustomCellEditorProps,
  CustomCellRendererProps,
} from "ag-grid-react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import {
  formatDateTimeCell,
  localDateTimeInputToCell,
  offsetMinutesFor,
  toDateTimeInputValue,
} from "~/lib/tables/datetime";
import type { GridTableRow } from "~/lib/tables/grid";
import type { TableColumn } from "@weaver/core/tables/types";
import { cn } from "~/lib/utils";
import { api } from "~/trpc/react";

export function selectCellLabel(column: TableColumn, value: unknown): string {
  if (typeof value !== "string" || value === "") return "—";
  return (
    column.options?.find((option) => option.id === value)?.label ??
    "Unavailable option"
  );
}

type BooleanCellRendererProps = CustomCellRendererProps<
  GridTableRow,
  CellValue | undefined
> & { columnName: string };

export function BooleanCellRenderer({
  value,
  columnName,
}: BooleanCellRendererProps) {
  return (
    <BooleanCellValue
      value={typeof value === "boolean" ? value : undefined}
      columnName={columnName}
    />
  );
}

export function BooleanCellValue({
  value,
  columnName,
}: {
  value: boolean | undefined;
  columnName: string;
}) {
  if (value === undefined) {
    return (
      <span className="text-text-muted flex h-full items-center select-text">
        <span aria-hidden="true">—</span>
        <span className="sr-only">{columnName}: empty</span>
      </span>
    );
  }

  return (
    <span className="flex h-full items-center gap-2">
      <input
        type="checkbox"
        checked={value}
        readOnly
        aria-label={`${columnName}: ${value ? "true" : "false"}`}
        className="accent-brand pointer-events-none size-4"
      />
      <span aria-hidden="true" className="select-text">
        {value ? "True" : "False"}
      </span>
    </span>
  );
}

type DocumentCellRendererProps = CustomCellRendererProps<
  GridTableRow,
  CellValue | undefined
> & {
  projectId: string;
  canEdit: boolean;
  references: ReadonlyMap<string, { id: string; title: string }>;
  referencesLoading: boolean;
};

export function DocumentCellRenderer({
  value,
  projectId,
  canEdit,
  references,
  referencesLoading,
  api: gridApi,
  node,
  column,
}: DocumentCellRendererProps) {
  const documentId = typeof value === "string" ? value : "";
  const target = references.get(documentId);
  const startEditing = () => {
    if (node.rowIndex === null || !column) return;
    gridApi.startEditingCell({
      rowIndex: node.rowIndex,
      colKey: column.getColId(),
    });
  };

  if (!documentId) {
    return canEdit ? (
      <DocumentEditTrigger label="Choose document" onActivate={startEditing} />
    ) : (
      <span className="text-text-muted">—</span>
    );
  }

  if (referencesLoading && !target) {
    return (
      <Skeleton aria-label="Loading document reference" className="h-5 w-28" />
    );
  }

  if (!target) {
    return canEdit ? (
      <DocumentEditTrigger
        label="Unavailable document"
        broken
        onActivate={startEditing}
      />
    ) : (
      <span
        role="note"
        aria-label="Broken document reference"
        className="border-danger-border bg-danger-bg text-danger inline-flex max-w-full truncate rounded-[4px] border px-1.5 line-through decoration-current/50"
      >
        Unavailable document
      </span>
    );
  }

  if (canEdit) {
    return (
      <DocumentEditTrigger label={target.title} onActivate={startEditing} />
    );
  }

  return (
    <Link
      href={`/projects/${projectId}/documents/${target.id}`}
      className="border-brand-border bg-brand-bg text-brand-text hover:text-brand-hover focus-visible:ring-brand/50 inline-flex max-w-full items-center gap-1 rounded-[4px] border px-1.5 no-underline outline-none focus-visible:ring-3"
    >
      <BookOpen className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{target.title}</span>
    </Link>
  );
}

function DocumentEditTrigger({
  label,
  broken = false,
  onActivate,
}: {
  label: string;
  broken?: boolean;
  onActivate: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onActivate}
      aria-label={`Choose document. Current value: ${label}`}
      className={cn(
        "border-brand-border bg-brand-bg text-brand-text hover:bg-hover focus-visible:ring-brand/50 inline-flex h-6 max-w-full items-center gap-1 rounded-[4px] border px-1.5 outline-none focus-visible:ring-3",
        broken &&
          "border-danger-border bg-danger-bg text-danger line-through decoration-current/50",
      )}
    >
      <BookOpen className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </button>
  );
}

type DocumentCellEditorProps = CustomCellEditorProps<
  GridTableRow,
  CellValue | undefined
> & { projectId: string };

export function DocumentCellEditor({
  projectId,
  initialValue,
  onValueChange,
  stopEditing,
}: DocumentCellEditorProps) {
  const inputId = useId();
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const documentsQuery = api.document.list.useQuery(
    {
      projectId,
      page: 1,
      pageSize: 20,
      sort: "title",
      dir: "asc",
      ...(debouncedQuery ? { search: debouncedQuery } : {}),
    },
    { placeholderData: keepPreviousData },
  );
  const items = documentsQuery.data?.items ?? [];
  const normalizedActiveIndex =
    items.length > 0 ? Math.min(activeIndex, items.length - 1) : 0;
  const activeItem = items[normalizedActiveIndex];
  const activeOptionId = activeItem
    ? `${listboxId}-option-${activeItem.id}`
    : undefined;

  const choose = (index: number) => {
    const item = items[index];
    if (!item) return;
    onValueChange(item.id);
    stopEditing(true);
  };

  return (
    <div className="bg-surface border-line w-[min(20rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)] rounded-[8px] border p-2 shadow-lg">
      <label
        htmlFor={inputId}
        className="text-text mb-1.5 block text-[12px] font-medium"
      >
        Choose a document
      </label>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="text-text-muted pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
        />
        <Input
          id={inputId}
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((current) =>
                items.length === 0
                  ? 0
                  : (Math.min(current, items.length - 1) + 1) % items.length,
              );
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((current) =>
                items.length === 0
                  ? 0
                  : (Math.min(current, items.length - 1) - 1 + items.length) %
                    items.length,
              );
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(normalizedActiveIndex);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onValueChange(initialValue);
              stopEditing(true);
            }
          }}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-activedescendant={activeOptionId}
          className="pl-8"
          placeholder="Search by title"
        />
      </div>

      {documentsQuery.isLoading ? (
        <div role="status" aria-label="Searching documents" className="mt-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="mt-1 h-10 w-full" />
        </div>
      ) : documentsQuery.error ? (
        <p
          role="alert"
          className="text-danger m-0 py-4 text-center text-[12px]"
        >
          Could not search documents
        </p>
      ) : items.length === 0 ? (
        <p
          role="status"
          className="text-text-3 m-0 py-4 text-center text-[12px]"
        >
          No matching documents
        </p>
      ) : (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Matching documents"
          className="scrollarea m-0 mt-2 max-h-52 list-none overflow-y-auto p-0"
        >
          {items.map((item, index) => (
            <li
              key={item.id}
              id={`${listboxId}-option-${item.id}`}
              role="option"
              aria-selected={index === normalizedActiveIndex}
              className={cn(
                "hover:bg-hover cursor-pointer rounded-[6px] px-2 py-1.5",
                index === normalizedActiveIndex && "bg-hover",
              )}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(index);
              }}
            >
              <span className="text-text block truncate text-[13px] font-medium">
                {item.title}
              </span>
              <span className="text-text-muted block truncate text-[11px]">
                {item.path}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="border-line mt-2 flex justify-end border-t pt-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onMouseDown={(event) => {
            event.preventDefault();
            onValueChange(undefined);
            stopEditing(true);
          }}
        >
          Clear
        </Button>
      </div>
    </div>
  );
}

type DateTimeCellRendererProps = CustomCellRendererProps<
  GridTableRow,
  CellValue | undefined
>;

export function DateTimeCellRenderer({ value }: DateTimeCellRendererProps) {
  if (typeof value !== "string" || value === "") {
    return <span className="text-text-muted select-text">—</span>;
  }
  return (
    <span title={value} className="select-text">
      {formatDateTimeCell(value)}
    </span>
  );
}

type DateTimeCellEditorProps = CustomCellEditorProps<
  GridTableRow,
  CellValue | undefined
>;

export function DateTimeCellEditor({
  initialValue,
  onValueChange,
}: DateTimeCellEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [offsetMinutes] = useState(() =>
    offsetMinutesFor(
      typeof initialValue === "string" ? initialValue : undefined,
    ),
  );
  const [input, setInput] = useState(() =>
    typeof initialValue === "string"
      ? toDateTimeInputValue(initialValue, offsetMinutes)
      : "",
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <input
      ref={inputRef}
      type="datetime-local"
      step="1"
      value={input}
      onChange={(event) => {
        const next = event.target.value;
        setInput(next);
        if (next === "") {
          onValueChange(undefined);
          return;
        }
        const parsed = localDateTimeInputToCell(
          next,
          typeof initialValue === "string" ? offsetMinutes : undefined,
        );
        // A non-empty but unparsable value (shouldn't happen from a native
        // datetime-local picker, but guard defensively) keeps the original
        // cell instead of silently clearing it.
        onValueChange(parsed ?? initialValue);
      }}
      className="border-line bg-surface text-text h-full w-full rounded-[4px] border px-2 py-1 text-[13px] outline-none"
    />
  );
}

type MultiselectCellRendererProps = CustomCellRendererProps<
  GridTableRow,
  CellValue | undefined
> & { column: TableColumn };

export function MultiselectCellRenderer({
  value,
  column,
}: MultiselectCellRendererProps) {
  if (!Array.isArray(value) || value.length === 0) {
    return <span className="text-text-muted select-text">—</span>;
  }
  return (
    <span className="flex h-full flex-wrap items-center gap-1 py-1">
      {value.map((id) => {
        const label =
          typeof id === "string"
            ? ((column.options ?? []).find((option) => option.id === id)
                ?.label ?? id)
            : String(id);
        return (
          <span
            key={String(id)}
            className="border-line bg-hover text-text-2 inline-flex max-w-full items-center truncate rounded-[4px] border px-1.5 text-[11px] select-text"
          >
            {label}
          </span>
        );
      })}
    </span>
  );
}

type MultiselectCellEditorProps = CustomCellEditorProps<
  GridTableRow,
  CellValue | undefined
> & { column: TableColumn };

/**
 * Stable, diff-friendly ordering: selected option ids in `column.options`
 * order rather than toggle/insertion order. Exported for direct unit tests.
 */
export function orderSelectedOptionIds(
  options: readonly { id: string }[],
  ids: readonly string[],
): string[] {
  const selectedIds = new Set(ids);
  return options
    .filter((option) => selectedIds.has(option.id))
    .map((option) => option.id);
}

export function MultiselectCellEditor({
  column,
  initialValue,
  onValueChange,
  stopEditing,
}: MultiselectCellEditorProps) {
  const listboxId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const options = column.options ?? [];
  const [selected, setSelected] = useState<string[]>(() =>
    orderSelectedOptionIds(
      options,
      Array.isArray(initialValue) ? initialValue : [],
    ),
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const activeOption = options[activeIndex];
  const activeOptionId = activeOption
    ? `${listboxId}-option-${activeOption.id}`
    : undefined;

  useEffect(() => {
    listRef.current?.focus();
  }, []);

  const toggle = (id: string) => {
    const nextIds = selected.includes(id)
      ? selected.filter((entry) => entry !== id)
      : [...selected, id];
    const next = orderSelectedOptionIds(options, nextIds);
    setSelected(next);
    // Commit on every toggle, not just Apply/Enter — a grid-driven stop
    // (click another cell, Tab, `stopEditingWhenCellsLoseFocus`) reads
    // getValue() immediately and would otherwise silently drop the
    // selection made so far.
    onValueChange(next.length > 0 ? next : undefined);
  };

  const commit = () => {
    onValueChange(selected.length > 0 ? selected : undefined);
    stopEditing(true);
  };

  const cancel = () => {
    onValueChange(initialValue);
    stopEditing(true);
  };

  return (
    <div className="bg-surface border-line w-[min(16rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)] rounded-[8px] border p-2 shadow-lg">
      <p className="text-text mb-1.5 block text-[12px] font-medium">
        Select {column.name} options
      </p>
      {options.length === 0 ? (
        <p className="text-text-3 m-0 py-4 text-center text-[12px]">
          No options configured
        </p>
      ) : (
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-multiselectable="true"
          aria-label={`${column.name} options`}
          aria-activedescendant={activeOptionId}
          tabIndex={0}
          className="scrollarea m-0 max-h-52 list-none space-y-0.5 overflow-y-auto p-0 outline-none"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((current) => (current + 1) % options.length);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex(
                (current) => (current - 1 + options.length) % options.length,
              );
            } else if (event.key === " ") {
              event.preventDefault();
              const option = options[activeIndex];
              if (option) toggle(option.id);
            } else if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancel();
            }
          }}
        >
          {options.map((option, index) => {
            const checked = selected.includes(option.id);
            return (
              <li
                key={option.id}
                id={`${listboxId}-option-${option.id}`}
                role="option"
                aria-selected={checked}
              >
                <label
                  className={cn(
                    "hover:bg-hover flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5",
                    index === activeIndex && "bg-hover",
                  )}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    tabIndex={-1}
                    onChange={() => toggle(option.id)}
                    className="accent-brand size-4"
                  />
                  <span className="text-text truncate text-[13px]">
                    {option.label}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <div className="border-line mt-2 flex justify-end gap-2 border-t pt-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onMouseDown={(event) => {
            event.preventDefault();
            onValueChange(undefined);
            stopEditing(true);
          }}
        >
          Clear
        </Button>
        <Button
          type="button"
          size="sm"
          onMouseDown={(event) => {
            event.preventDefault();
            commit();
          }}
        >
          Apply
        </Button>
      </div>
    </div>
  );
}

type UrlCellRendererProps = CustomCellRendererProps<
  GridTableRow,
  CellValue | undefined
>;

function urlDisplayLabel(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return value;
  }
}

export function UrlCellRenderer({ value }: UrlCellRendererProps) {
  if (typeof value !== "string" || value === "") {
    return <span className="text-text-muted select-text">—</span>;
  }
  if (!isValidUrlCell(value)) {
    return <span className="text-text truncate select-text">{value}</span>;
  }
  return (
    <a
      href={value}
      target="_blank"
      rel="noopener noreferrer"
      className="border-brand-border bg-brand-bg text-brand-text hover:text-brand-hover focus-visible:ring-brand/50 inline-flex max-w-full items-center gap-1 truncate rounded-[4px] border px-1.5 no-underline outline-none focus-visible:ring-3"
    >
      <span className="truncate">{urlDisplayLabel(value)}</span>
    </a>
  );
}

type LongTextCellRendererProps = CustomCellRendererProps<
  GridTableRow,
  CellValue | undefined
> & { columnName: string; onExpand: (text: string) => void };

/**
 * Renders a preview only; the expand dialog itself lives at grid level
 * (`TableGrid.tsx`) so AG Grid recycling this renderer's cell never unmounts
 * an open dialog out from under the viewer.
 */
export function LongTextCellRenderer({
  value,
  columnName,
  onExpand,
}: LongTextCellRendererProps) {
  const text = typeof value === "string" ? value : "";
  const firstLine = text.split("\n")[0] ?? "";

  if (!text) {
    return <span className="text-text-muted select-text">—</span>;
  }

  return (
    <span className="flex h-full items-center gap-1.5">
      <span className="truncate select-text">{firstLine}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Expand ${columnName}`}
        onClick={() => onExpand(text)}
      >
        <Maximize2 className="size-3.5" />
      </Button>
    </span>
  );
}
