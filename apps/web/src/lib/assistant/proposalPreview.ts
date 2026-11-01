import type { TableDiff } from "@weaver/core/tables/diff";
import {
  COLUMN_TYPES,
  type CellValue,
  type ColumnType,
  type SelectOption,
  type TableColumn,
  type TableRow,
} from "@weaver/core/tables/types";
import { humanAssistantError } from "~/lib/assistant/conversationErrors";
import type { DiffLine } from "~/lib/documents/diff-view";
import type { TableDiffSection } from "~/lib/tables/presentation";

/**
 * The shapes `prepare()` in packages/core/src/services/assistantProposals.ts
 * actually stores in `AssistantProposal.preview`:
 *
 * - document.create / document.edit / document.patch → `linePreview` →
 *   `{ kind: "document", lines, truncated }`
 * - table.create → `{ kind: "table", columns, rowCount, sampleRows }`
 * - table.schema / table.rows → `{ kind: "table", diff }`
 * - table.change → `{ kind: "table", diff, columns }`
 * - content.restore (mode=version) → `{ kind: "document", lines, truncated }`
 *   or `{ kind: "table", diff, columns }`, the same shape as the edit it
 *   restores; (mode=deleted) → `{ kind: "table", columns, rowCount,
 *   sampleRows }` for a table or `{ kind: "document", lines, truncated }` for
 *   a document, mirroring the create preview since there is no prior
 *   revision on the live side to diff against.
 * - content.lifecycle → `{ kind: "lifecycle", action, resourceType, from, to,
 *   title, affected: { documents, tables } }`.
 * - exam.create / exam.update → `{ kind: "document", lines, truncated }` over
 *   a text rendering of the exam (examProposals.ts).
 *
 * Every one of them passes through `boundedJson`, which can append
 * `truncated: true` to a shrunk payload or collapse the whole thing to a bare
 * `{ truncated: true }` marker — hence the `unknown` arm.
 */
export type ParsedPreview =
  | { kind: "document"; lines: DiffLine[]; truncated: boolean }
  | {
      kind: "table-diff";
      diff: TableDiff;
      columns: TableColumn[];
      truncated: boolean;
    }
  | {
      kind: "table-create";
      columns: TableColumn[];
      rowCount: number;
      sampleRows: TableRow[];
      truncated: boolean;
    }
  | {
      kind: "lifecycle";
      action: string;
      resourceType: "document" | "table";
      /** Repository-relative source; null for a folder create. */
      from: string | null;
      /** Destination; null for a delete, "" for the scope root. */
      to: string | null;
      title: string | null;
      affected: { documents: number; tables: number };
      truncated: boolean;
    }
  | { kind: "unknown" };

const KIND_LABELS: Record<string, string> = {
  "exam.create": "New exam",
  "exam.update": "Exam change",
  "document.create": "New document",
  "document.edit": "Document edit",
  "document.patch": "Document patch",
  "table.create": "New table",
  "table.schema": "Table schema change",
  "table.rows": "Table rows",
  "table.change": "Table change",
  "content.restore": "Restore",
  "content.restore.document": "Restore document",
  "content.restore.table": "Restore table",
  "content.lifecycle.folder_create": "New folder",
  "content.lifecycle.folder_rename": "Rename folder",
  "content.lifecycle.folder_move": "Move folder",
  "content.lifecycle.folder_delete": "Delete folder",
  "content.lifecycle.item_move.document": "Move document",
  "content.lifecycle.item_move.table": "Move table",
  "content.lifecycle.item_delete.document": "Delete document",
  "content.lifecycle.item_delete.table": "Delete table",
};

export function proposalKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isColumnType = (value: unknown): value is ColumnType =>
  typeof value === "string" &&
  (COLUMN_TYPES as readonly string[]).includes(value);

const isCellValue = (value: unknown): value is CellValue =>
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

function parseSelectOption(value: unknown): SelectOption | null {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string"
    ? { id: value.id, label: value.label }
    : null;
}

function parseColumn(value: unknown): TableColumn | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.name !== "string")
    return null;
  if (!isColumnType(value.type)) return null;
  const options = Array.isArray(value.options)
    ? value.options.flatMap((option) => {
        const parsed = parseSelectOption(option);
        return parsed ? [parsed] : [];
      })
    : null;
  return {
    id: value.id,
    name: value.name,
    type: value.type,
    ...(options ? { options } : {}),
  };
}

function parseRow(value: unknown): TableRow | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const cells: Record<string, CellValue> = {};
  if (isRecord(value.cells)) {
    for (const [columnId, cell] of Object.entries(value.cells)) {
      if (isCellValue(cell)) cells[columnId] = cell;
    }
  }
  return { id: value.id, cells };
}

/**
 * `presentTableDiff` calls `assertNever` on an unrecognised column change, so
 * a malformed stored preview must be filtered out here rather than cast — a
 * throw would take the whole transcript down with it.
 */
function parseColumnChange(
  value: unknown,
): TableDiff["columnChanges"][number] | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "added":
    case "removed": {
      const column = parseColumn(value.column);
      return column ? { kind: value.kind, column } : null;
    }
    case "renamed":
      return typeof value.columnId === "string" &&
        typeof value.from === "string" &&
        typeof value.to === "string"
        ? {
            kind: "renamed",
            columnId: value.columnId,
            from: value.from,
            to: value.to,
          }
        : null;
    case "retyped":
      return typeof value.columnId === "string" &&
        isColumnType(value.from) &&
        isColumnType(value.to)
        ? {
            kind: "retyped",
            columnId: value.columnId,
            from: value.from,
            to: value.to,
          }
        : null;
    case "options":
      return typeof value.columnId === "string"
        ? { kind: "options", columnId: value.columnId }
        : null;
    default:
      return null;
  }
}

function parseCellChange(
  value: unknown,
): TableDiff["changedCells"][number] | null {
  if (!isRecord(value)) return null;
  if (typeof value.rowId !== "string" || typeof value.columnId !== "string")
    return null;
  const from = value.from ?? null;
  const to = value.to ?? null;
  if (from !== null && !isCellValue(from)) return null;
  if (to !== null && !isCellValue(to)) return null;
  return { rowId: value.rowId, columnId: value.columnId, from, to };
}

function parseStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function compact<T>(value: unknown, parse: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = parse(item);
    return parsed === null ? [] : [parsed];
  });
}

function parseDiff(value: Record<string, unknown>): TableDiff {
  const titleChange = value.titleChange;
  return {
    titleChange:
      isRecord(titleChange) &&
      typeof titleChange.from === "string" &&
      typeof titleChange.to === "string"
        ? { from: titleChange.from, to: titleChange.to }
        : null,
    columnChanges: compact(value.columnChanges, parseColumnChange),
    columnsReordered: value.columnsReordered === true,
    rowsReordered: value.rowsReordered === true,
    addedRows: parseStrings(value.addedRows),
    removedRows: parseStrings(value.removedRows),
    changedCells: compact(value.changedCells, parseCellChange),
  };
}

const asCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;

const asPath = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/** Narrow the stored `preview` JSON without trusting any of it. */
export function parsePreview(preview: unknown): ParsedPreview {
  if (!isRecord(preview)) return { kind: "unknown" };
  const truncated = preview.truncated === true;

  if (preview.kind === "document" && Array.isArray(preview.lines)) {
    const lines = preview.lines.filter(
      (line): line is DiffLine =>
        isRecord(line) &&
        typeof line.text === "string" &&
        (line.type === "add" || line.type === "del" || line.type === "same"),
    );
    return { kind: "document", lines, truncated };
  }

  if (preview.kind === "table") {
    if (isRecord(preview.diff))
      return {
        kind: "table-diff",
        diff: parseDiff(preview.diff),
        columns: compact(preview.columns, parseColumn),
        truncated,
      };
    if (Array.isArray(preview.columns))
      return {
        kind: "table-create",
        columns: compact(preview.columns, parseColumn),
        rowCount:
          typeof preview.rowCount === "number" &&
          Number.isFinite(preview.rowCount)
            ? preview.rowCount
            : 0,
        sampleRows: compact(preview.sampleRows, parseRow),
        truncated,
      };
  }

  if (
    preview.kind === "lifecycle" &&
    typeof preview.action === "string" &&
    (preview.resourceType === "document" || preview.resourceType === "table")
  ) {
    const affected = isRecord(preview.affected) ? preview.affected : {};
    return {
      kind: "lifecycle",
      action: preview.action,
      resourceType: preview.resourceType,
      from: asPath(preview.from),
      to: asPath(preview.to),
      title: typeof preview.title === "string" ? preview.title : null,
      affected: {
        documents: asCount(affected.documents),
        tables: asCount(affected.tables),
      },
      truncated,
    };
  }

  return { kind: "unknown" };
}

export type CappedDiffSection = TableDiffSection & { hidden: number };

/** Keep a preview bounded: long sections show `max` items plus a count. */
export function capDiffSections(
  sections: readonly TableDiffSection[],
  max: number,
): CappedDiffSection[] {
  return sections.map((section) => ({
    ...section,
    items: section.items.slice(0, max),
    hidden: Math.max(0, section.items.length - max),
  }));
}

/**
 * `null` means "the clock isn't trustworthy yet" — before mount, so the server
 * render and the client's first paint agree (the same reason `useMounted`
 * gates every other date in the panel).
 */
export function isProposalExpired(
  proposal: { status: string; expiresAt: Date },
  now: number | null,
): boolean {
  if (proposal.status === "expired") return true;
  return now !== null && proposal.expiresAt.getTime() <= now;
}

export function pendingProposalCount(
  proposals: ReadonlyArray<{ status: string; expiresAt: Date }>,
  now: number | null,
): number {
  return proposals.filter(
    (proposal) =>
      proposal.status === "pending" && !isProposalExpired(proposal, now),
  ).length;
}

/**
 * `Date.now()` called straight from a component body trips the
 * react-hooks/purity rule (see `msSincePending` in Transcript.tsx); reading it
 * through an ordinarily-named imported helper does not.
 */
export function clientNow(mounted: boolean): number | null {
  return mounted ? Date.now() : null;
}

/**
 * Mirrors `MAX_PREVIEW_LINES` in
 * packages/core/src/services/assistantProposals.ts. Not imported from there:
 * that module pulls in Prisma and node:crypto, which must not reach a client
 * bundle. `linePreview` slices to exactly this many lines when it fires, so
 * the count is what tells the two truncation causes apart.
 */
export const PREVIEW_LINE_LIMIT = 2_000;

/**
 * `truncated` alone cannot say *why*: `linePreview` sets it when the diff
 * exceeded PREVIEW_LINE_LIMIT, but `boundedJson` also sets it after byte-budget
 * shrinking, which cuts the array at an arbitrary point. Claiming a 2,000-line
 * limit over 40 shown lines would be a false statement, so key the copy off the
 * data actually present.
 */
export function truncationNote(
  lineCount: number,
  truncated: boolean,
): string | null {
  if (!truncated) return null;
  return lineCount >= PREVIEW_LINE_LIMIT
    ? `Preview limited to ${PREVIEW_LINE_LIMIT.toLocaleString("en-US")} lines`
    : "Preview shortened";
}

/**
 * What the card must do when `acceptProposal` throws. Pure so the node test
 * environment can assert it: a FORBIDDEN accept has to invalidate the role
 * query too, or `canAccept` stays true and the Accept button survives to
 * repeat the identical failure.
 */
export function acceptErrorAction(
  code: string | undefined,
  message: string | undefined,
): { toast: string | null; refreshProposal: boolean; refreshRole: boolean } {
  if (code === "FORBIDDEN")
    return {
      toast: "You no longer have Editor access here",
      refreshProposal: false,
      refreshRole: true,
    };
  // The server already decided (expired, or resolved in another tab);
  // re-fetch and render whatever it says rather than guessing.
  if (code === "CONFLICT")
    return { toast: null, refreshProposal: true, refreshRole: false };
  return {
    // A bare CoreError code (PRECONDITION_FAILED, INTERNAL_SERVER_ERROR, …)
    // would otherwise be toasted verbatim.
    toast: humanAssistantError(message, "Couldn’t accept the proposal"),
    refreshProposal: false,
    refreshRole: false,
  };
}
