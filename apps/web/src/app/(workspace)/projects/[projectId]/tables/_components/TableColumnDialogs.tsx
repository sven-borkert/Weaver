"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";

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
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  COLUMN_TYPES,
  hasOptions,
  type ColumnType,
  type SelectOption,
  type TableColumn,
  type TableRow,
} from "@weaver/core/tables/types";

/** Client-side mirror of the server's table column name and type fields. */
const columnSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(100),
  type: z.enum(COLUMN_TYPES),
});

type ColumnFormValues = z.infer<typeof columnSchema>;

export type TableColumnDialogOperation =
  | { kind: "add" }
  | { kind: "rename"; column: TableColumn }
  | { kind: "retype"; column: TableColumn }
  | { kind: "options"; column: TableColumn }
  | { kind: "delete"; column: TableColumn };

type TableColumnDialogsProps = {
  rows: TableRow[];
  operation: TableColumnDialogOperation | null;
  onClose: () => void;
  onAdd: (column: TableColumn) => void;
  onReplace: (column: TableColumn) => string[];
  onRetype: (column: TableColumn) => string[];
  onDelete: (columnId: string) => void;
};

const columnTypeLabels: Record<ColumnType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  datetime: "Date & time",
  select: "Select",
  multiselect: "Multi-select",
  boolean: "Boolean",
  url: "URL",
  longtext: "Long text",
  document: "Document",
};

/**
 * Per-pair copy explaining a lossy or narrowing retype conversion, keyed by
 * `${from}->${to}`. Falls back to the generic retype sentence.
 */
const retypeExplanations: Record<string, string> = {
  "date->datetime": "Dates become midnight UTC.",
  "datetime->date":
    "Only the calendar date is kept; the time of day is dropped.",
  "multiselect->select": "Only the first selected option is kept.",
  "multiselect->text": "Options are joined with commas.",
  "multiselect->longtext": "Options are joined with commas.",
  "text->url":
    "Cells that are not http(s) links block the change and are listed below.",
  "longtext->url":
    "Cells that are not http(s) links block the change and are listed below.",
  "text->multiselect":
    "Values are split on commas and matched to option labels; an unknown label blocks the change.",
  "longtext->multiselect":
    "Values are split on commas and matched to option labels; an unknown label blocks the change.",
  "select->multiselect": "Each value becomes a single selection.",
};

/** Exported so the per-pair retype copy can be unit-tested directly. */
export function retypeDescription(
  from: ColumnType | undefined,
  to: ColumnType,
): string {
  if (!from) return "Convert every populated cell atomically to the new type.";
  return (
    retypeExplanations[`${from}->${to}`] ??
    "Convert every populated cell atomically to the new type."
  );
}

function nextUuid(): string {
  return window.crypto.randomUUID();
}

function initialOptions(operation: TableColumnDialogOperation): SelectOption[] {
  if (operation.kind === "add") return [];
  return (operation.column.options ?? []).map((option) => ({ ...option }));
}

/**
 * Whether the column form shows the options editor for an operation/type
 * pair. Exported so it can be unit-tested directly — Radix's Dialog portal
 * renders nothing under this repo's Node-environment component tests
 * (no jsdom), so a full DOM render of the dialog can't assert on this.
 */
export function shouldEditOptions(
  operationKind: TableColumnDialogOperation["kind"],
  type: ColumnType,
): boolean {
  return (
    operationKind === "options" ||
    (operationKind !== "rename" &&
      operationKind !== "delete" &&
      hasOptions(type))
  );
}

export function OptionsEditor({
  options,
  onChange,
}: {
  options: SelectOption[];
  onChange: (options: SelectOption[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <Label>Select options</Label>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={options.length >= 200}
          onClick={() => onChange([...options, { id: nextUuid(), label: "" }])}
        >
          <Plus data-icon="inline-start" />
          Add option
        </Button>
      </div>
      <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
        {options.map((option, index) => (
          <div key={option.id} className="flex items-center gap-2">
            <Input
              value={option.label}
              maxLength={100}
              aria-label={`Option ${index + 1} label`}
              onChange={(event) =>
                onChange(
                  options.map((entry) =>
                    entry.id === option.id
                      ? { ...entry, label: event.target.value }
                      : entry,
                  ),
                )
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove option ${index + 1}`}
              disabled={options.length === 1}
              onClick={() =>
                onChange(options.filter((entry) => entry.id !== option.id))
              }
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
      <p className="text-text-3 m-0 text-[12px]">
        Option identities stay stable when labels change.
      </p>
    </div>
  );
}

function ColumnFormDialog({
  rows,
  operation,
  onClose,
  onAdd,
  onReplace,
  onRetype,
}: Omit<TableColumnDialogsProps, "operation" | "onDelete"> & {
  operation: Exclude<TableColumnDialogOperation, { kind: "delete" }>;
}) {
  const currentColumn = operation.kind === "add" ? undefined : operation.column;
  const [options, setOptions] = useState<SelectOption[]>(() =>
    initialOptions(operation),
  );
  const [optionsError, setOptionsError] = useState<string>();
  const [invalidRows, setInvalidRows] = useState<string[]>([]);
  const {
    control,
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ColumnFormValues>({
    resolver: zodResolver(columnSchema),
    defaultValues: {
      name: currentColumn?.name ?? "",
      type: currentColumn?.type ?? "text",
    },
  });
  const selectedType = useWatch({ control, name: "type" });
  const editsOptions = shouldEditOptions(operation.kind, selectedType);

  const onSubmit = handleSubmit((values) => {
    const nextOptions = hasOptions(values.type)
      ? options.map((option) => ({
          ...option,
          label: option.label.trim(),
        }))
      : undefined;
    if (hasOptions(values.type)) {
      if (nextOptions!.length === 0) {
        setOptionsError("Add at least one option");
        return;
      }
      if (nextOptions!.some((option) => option.label.length === 0)) {
        setOptionsError("Every option needs a label");
        return;
      }
      if (
        new Set(nextOptions!.map((option) => option.id)).size !==
        nextOptions!.length
      ) {
        setOptionsError("Option identifiers must be unique");
        return;
      }
    }

    setOptionsError(undefined);
    setInvalidRows([]);
    const column: TableColumn = {
      id: currentColumn?.id ?? nextUuid(),
      name: values.name,
      type: values.type,
      ...(nextOptions ? { options: nextOptions } : {}),
    };

    if (operation.kind === "add") {
      onAdd(column);
      onClose();
      return;
    }

    const failures =
      operation.kind === "retype" ? onRetype(column) : onReplace(column);
    if (failures.length > 0) {
      setInvalidRows(failures);
      return;
    }
    onClose();
  });

  const title = {
    add: "Add column",
    rename: "Rename column",
    retype: "Change column type",
    options: "Edit select options",
  }[operation.kind];
  const description = {
    add: "Add a typed column to the local table draft.",
    rename: "Change this column's display name in the local draft.",
    retype: retypeDescription(currentColumn?.type, selectedType),
    options: "Rename, add, or remove the stable options for this column.",
  }[operation.kind];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {operation.kind !== "options" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="table-column-name">Name</Label>
              <Input
                id="table-column-name"
                autoFocus
                maxLength={100}
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={
                  errors.name ? "table-column-name-error" : undefined
                }
                {...register("name")}
              />
              {errors.name ? (
                <p
                  id="table-column-name-error"
                  role="alert"
                  className="text-danger m-0 text-[12px]"
                >
                  {errors.name.message}
                </p>
              ) : null}
            </div>
          ) : null}

          {operation.kind === "add" || operation.kind === "retype" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="table-column-type">Type</Label>
              <Controller
                control={control}
                name="type"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(value: ColumnType) => {
                      field.onChange(value);
                      if (hasOptions(value) && options.length === 0) {
                        setOptions([{ id: nextUuid(), label: "" }]);
                      }
                    }}
                  >
                    <SelectTrigger id="table-column-type" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {COLUMN_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {columnTypeLabels[type]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          ) : null}

          {editsOptions ? (
            <OptionsEditor options={options} onChange={setOptions} />
          ) : null}

          {optionsError ? (
            <p role="alert" className="text-danger m-0 text-[12px]">
              {optionsError}
            </p>
          ) : null}
          {invalidRows.length > 0 ? (
            <div
              role="alert"
              className="border-danger/40 bg-danger/10 rounded-lg border p-3"
            >
              <p className="text-danger m-0 text-[13px] font-medium">
                This change would invalidate populated rows. No changes were
                applied.
              </p>
              <ul className="text-danger mt-2 mb-0 max-h-28 overflow-y-auto pl-5 text-[12px]">
                {invalidRows.map((rowId) => (
                  <li key={rowId}>
                    Row {rows.findIndex((row) => row.id === rowId) + 1}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit">
              {operation.kind === "add" ? "Add column" : "Apply"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteColumnDialog({
  column,
  onClose,
  onDelete,
}: {
  column: TableColumn;
  onClose: () => void;
  onDelete: (columnId: string) => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete column</DialogTitle>
          <DialogDescription>
            Delete <strong>{column.name}</strong>? Its cells will be removed
            from every row in the local draft.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              onDelete(column.id);
              onClose();
            }}
          >
            Delete column
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TableColumnDialogs({
  rows,
  operation,
  onClose,
  onAdd,
  onReplace,
  onRetype,
  onDelete,
}: TableColumnDialogsProps) {
  if (!operation) return null;
  if (operation.kind === "delete") {
    return (
      <DeleteColumnDialog
        column={operation.column}
        onClose={onClose}
        onDelete={onDelete}
      />
    );
  }

  const operationKey =
    operation.kind === "add"
      ? operation.kind
      : `${operation.kind}:${operation.column.id}`;
  return (
    <ColumnFormDialog
      rows={rows}
      key={operationKey}
      operation={operation}
      onClose={onClose}
      onAdd={onAdd}
      onReplace={onReplace}
      onRetype={onRetype}
    />
  );
}
