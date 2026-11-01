"use client";

import type { Editor } from "@tiptap/core";
import { BookOpen, FileText, Search, Table2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { DocumentKind } from "@weaver/core/documents/kinds";
import { DocumentKindIcon } from "~/components/icons/DocumentKindIcon";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import {
  activeReferencePickerView,
  referencePickerTabSemantics,
  switchReferenceTargetType,
  updateActiveReferenceQuery,
  type ReferencePickerState,
  type ReferenceTargetType,
} from "~/lib/documents/reference-picker-state";
import { cn } from "~/lib/utils";
import { api } from "~/trpc/react";

type CrossReferencePickerProps = {
  projectId: string;
  editor: Editor;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  hideTrigger?: boolean;
  onBeforeSelect?: () => boolean;
};

type ReferencePickerItem = {
  id: string;
  title: string;
  path: string;
  documentKind?: DocumentKind;
};

type ReferencePickerView = {
  targetType: ReferenceTargetType;
  query: string;
  items: ReferencePickerItem[];
  activeIndex: number;
  presentation: "loading" | "error" | "empty" | "results";
  hasError: boolean;
};

type ReferencePickerPanelProps = {
  targetType: ReferenceTargetType;
  baseId: string;
  active: boolean;
  open: boolean;
  view: ReferencePickerView;
  onQueryChange: (query: string) => void;
  onActiveIndexChange: (index: number) => void;
  onSelect: (index: number) => void;
  onClose: () => void;
  disabled: boolean;
};

function ReferencePickerPanel({
  targetType,
  baseId,
  active,
  open,
  view,
  onQueryChange,
  onActiveIndexChange,
  onSelect,
  onClose,
  disabled,
}: ReferencePickerPanelProps) {
  const semantics = referencePickerTabSemantics(targetType, baseId);
  const activeItem = view.items[view.activeIndex];
  const activeItemId = activeItem
    ? `${semantics.listboxId}-option-${activeItem.id}`
    : undefined;

  useEffect(() => {
    if (!active || !open || !activeItemId) return;
    document.getElementById(activeItemId)?.scrollIntoView({ block: "nearest" });
  }, [active, activeItemId, open]);

  const moveActiveIndex = (delta: -1 | 1) => {
    if (view.items.length === 0) {
      onActiveIndexChange(0);
      return;
    }

    onActiveIndexChange(
      (Math.min(view.activeIndex, view.items.length - 1) +
        delta +
        view.items.length) %
        view.items.length,
    );
  };

  return (
    <>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="text-text-muted pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
        />
        <Input
          id={semantics.comboboxId}
          autoFocus={active}
          value={view.query}
          disabled={disabled}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveActiveIndex(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveActiveIndex(-1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              onSelect(view.activeIndex);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
          role="combobox"
          aria-label={semantics.searchLabel}
          aria-autocomplete="list"
          aria-expanded={active && open}
          aria-controls={semantics.listboxId}
          aria-activedescendant={active ? activeItemId : undefined}
          className="pl-8"
          placeholder={semantics.searchLabel}
        />
      </div>

      {view.presentation === "loading" ? (
        <div role="status" aria-label={semantics.searchLabel}>
          <span className="sr-only">{semantics.searchLabel}…</span>
          <Skeleton className="h-12 w-full" />
          <Skeleton className="mt-2 h-12 w-full" />
        </div>
      ) : view.presentation === "error" ? (
        <p
          role="alert"
          className="text-danger m-0 py-5 text-center text-[12px]"
        >
          Could not search {targetType}s
        </p>
      ) : view.presentation === "empty" ? (
        <p
          role="status"
          aria-live="polite"
          className="text-text-3 m-0 py-5 text-center text-[12px]"
        >
          No matching {targetType}s
        </p>
      ) : (
        <>
          {view.hasError ? (
            <p role="status" className="text-danger m-0 text-[12px]">
              Could not refresh results. Showing saved results.
            </p>
          ) : null}
          <ul
            id={semantics.listboxId}
            role="listbox"
            aria-label={semantics.matchingLabel}
            className="scrollarea m-0 max-h-64 list-none overflow-y-auto p-0"
          >
            {view.items.map((item, index) => (
              <li
                key={item.id}
                id={`${semantics.listboxId}-option-${item.id}`}
                role="option"
                aria-selected={index === view.activeIndex}
                className={cn(
                  "hover:bg-hover min-h-11 cursor-pointer rounded-[6px] px-2 py-2",
                  index === view.activeIndex && "bg-hover",
                )}
                onMouseEnter={() => onActiveIndexChange(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  if (!disabled) onSelect(index);
                }}
              >
                <span className="text-text flex min-w-0 items-center gap-1.5 text-[13px] font-medium">
                  {item.documentKind ? (
                    <DocumentKindIcon
                      kind={item.documentKind}
                      className="size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                  ) : null}
                  <span className="truncate">{item.title}</span>
                </span>
                <span className="text-text-muted block truncate text-[11px]">
                  {item.path}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

export function CrossReferencePicker({
  projectId,
  editor,
  open,
  onOpenChange,
  disabled = false,
  hideTrigger = false,
  onBeforeSelect,
}: CrossReferencePickerProps) {
  const pickerId = useId();
  const anchor = useRef({
    getBoundingClientRect: () => {
      if (editor.isDestroyed) return new DOMRect();
      const coords = editor.view.coordsAtPos(editor.state.selection.from);
      return new DOMRect(
        coords.left,
        coords.top,
        Math.max(1, coords.right - coords.left),
        coords.bottom - coords.top,
      );
    },
  });
  const [pickerState, setPickerState] = useState<ReferencePickerState>({
    activeType: "document",
    activeIndex: 0,
    queries: { document: "", table: "" },
  });
  const [debouncedQueries, setDebouncedQueries] = useState<
    Record<ReferenceTargetType, string>
  >({ document: "", table: "" });
  const query = pickerState.queries[pickerState.activeType];

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedQueries((current) => ({
        ...current,
        [pickerState.activeType]: query.trim(),
      }));
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [pickerState.activeType, query]);

  const documentsQuery = api.document.list.useQuery(
    {
      projectId,
      page: 1,
      pageSize: 20,
      sort: "title",
      dir: "asc",
      ...(debouncedQueries.document
        ? { search: debouncedQueries.document }
        : {}),
    },
    { enabled: open && pickerState.activeType === "document" },
  );
  const tablesQuery = api.table.list.useQuery(
    {
      projectId,
      page: 1,
      pageSize: 20,
      sort: "title",
      dir: "asc",
      ...(debouncedQueries.table ? { search: debouncedQueries.table } : {}),
    },
    { enabled: open && pickerState.activeType === "table" },
  );
  const results = {
    document: {
      items: documentsQuery.data?.items ?? [],
      isLoading: documentsQuery.isLoading,
      hasError: Boolean(documentsQuery.error),
    },
    table: {
      items: tablesQuery.data?.items ?? [],
      isLoading: tablesQuery.isLoading,
      hasError: Boolean(tablesQuery.error),
    },
  };
  const documentView = activeReferencePickerView<ReferencePickerItem>(
    { ...pickerState, activeType: "document" },
    results,
  );
  const tableView = activeReferencePickerView<ReferencePickerItem>(
    { ...pickerState, activeType: "table" },
    results,
  );

  const close = () => {
    onOpenChange(false);
    setPickerState({
      activeType: "document",
      activeIndex: 0,
      queries: { document: "", table: "" },
    });
    setDebouncedQueries({ document: "", table: "" });
  };

  const select = (targetType: ReferenceTargetType, index: number) => {
    if (
      disabled ||
      !editor.isEditable ||
      editor.isDestroyed ||
      (onBeforeSelect && !onBeforeSelect())
    )
      return;
    const view = targetType === "document" ? documentView : tableView;
    const item = view.items[index];
    if (!item) return;

    editor
      .chain()
      .focus()
      .insertContent({
        type: "crossref",
        attrs: {
          targetType,
          targetId: item.id,
          label: item.title,
        },
      })
      .run();
    close();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen && !disabled && editor.isEditable) onOpenChange(true);
        else close();
      }}
    >
      {hideTrigger ? (
        <PopoverAnchor virtualRef={anchor} />
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="outline"
                aria-label="Insert cross-reference"
                disabled={disabled}
              >
                <BookOpen />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>Insert cross-reference</TooltipContent>
        </Tooltip>
      )}
      <PopoverContent
        align="start"
        className="max-h-[70dvh] w-80 max-w-[calc(100vw-1.5rem)] overflow-y-auto"
        onEscapeKeyDown={(event) => {
          if (event.isComposing) event.preventDefault();
          else event.stopPropagation();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!disabled && editor.isEditable && !editor.isDestroyed)
            editor.commands.focus(undefined, { scrollIntoView: false });
        }}
      >
        <PopoverHeader>
          <PopoverTitle>Link a reference</PopoverTitle>
          <PopoverDescription>
            Search this project by document or table title.
          </PopoverDescription>
        </PopoverHeader>
        <Tabs
          value={pickerState.activeType}
          onValueChange={(value) =>
            setPickerState((current) =>
              switchReferenceTargetType(
                current,
                value === "table" ? "table" : "document",
              ),
            )
          }
          className="gap-3"
        >
          <TabsList aria-label="Reference type" className="w-full">
            <TabsTrigger value="document" disabled={disabled}>
              <FileText />
              Documents
            </TabsTrigger>
            <TabsTrigger value="table" disabled={disabled}>
              <Table2 />
              Tables
            </TabsTrigger>
          </TabsList>
          <TabsContent
            value="document"
            forceMount
            className="m-0 flex flex-col gap-2 data-[state=inactive]:hidden"
          >
            <ReferencePickerPanel
              targetType="document"
              baseId={pickerId}
              active={pickerState.activeType === "document"}
              open={open}
              disabled={disabled}
              view={documentView}
              onQueryChange={(query) =>
                setPickerState((current) =>
                  updateActiveReferenceQuery(current, query),
                )
              }
              onActiveIndexChange={(activeIndex) =>
                setPickerState((current) => ({ ...current, activeIndex }))
              }
              onSelect={(index) => select("document", index)}
              onClose={close}
            />
          </TabsContent>
          <TabsContent
            value="table"
            forceMount
            className="m-0 flex flex-col gap-2 data-[state=inactive]:hidden"
          >
            <ReferencePickerPanel
              targetType="table"
              baseId={pickerId}
              active={pickerState.activeType === "table"}
              open={open}
              disabled={disabled}
              view={tableView}
              onQueryChange={(query) =>
                setPickerState((current) =>
                  updateActiveReferenceQuery(current, query),
                )
              }
              onActiveIndexChange={(activeIndex) =>
                setPickerState((current) => ({ ...current, activeIndex }))
              }
              onSelect={(index) => select("table", index)}
              onClose={close}
            />
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
