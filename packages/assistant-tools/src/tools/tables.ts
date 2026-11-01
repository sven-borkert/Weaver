import { getTableAtSnapshot, listTables } from "@weaver/core/services/tables";
import {
  columnsById,
  compareCells,
  compareIds,
  filterRows,
  requireColumn,
  tableFiltersSchema,
  tableSortSchema,
} from "@weaver/core/tables/query";
import {
  hasOptions,
  type CellValue,
  type ColumnType,
  type TableColumn,
  type TableRow,
} from "@weaver/core/tables/types";
import { z } from "zod";
import {
  boundItems,
  defineTool,
  newOutputBudget,
  newPageBudget,
  requireScope,
} from "../contract";
import {
  atCommitShaInput,
  continuationCursor,
  cursorInput,
  resolvePinnedRequest,
} from "./snapshotReads";

// The typed query language lives in core (design §8.2); re-exported here so
// every existing importer of this module keeps working unchanged.
export {
  coerceFilterValue,
  compareCells,
  compareIds,
  matchesFilter,
  tableFiltersSchema,
  tableSortSchema,
  type TableFilter,
} from "@weaver/core/tables/query";

const MAX_CITED_COLUMN_IDS = 50;

/** Caps a citation's columnIds at sourceLocatorSchema's table-variant limit (citations.ts:26) so a wide table's citation is still emitted, not silently dropped by validateSourceLocators. */
export function citedColumnIds(ids: readonly string[]): string[] {
  return ids.slice(0, MAX_CITED_COLUMN_IDS);
}

export const MAX_INLINE_CELL_CHARS = 2_000;

export const rowQuerySchema = z.object({
  select: z.array(z.string()).max(100).optional(),
  filters: tableFiltersSchema.optional(),
  sort: tableSortSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type RowQuery = z.infer<typeof rowQuerySchema>;

export type QueriedRow = {
  id: string;
  cells: Record<string, CellValue>;
  /** Strings longer than MAX_INLINE_CELL_CHARS are omitted from cells and listed here; read_table_cell retrieves them. */
  oversizedCells?: Array<{ columnId: string; chars: number }>;
};

/** Projects and strips oversized strings; the only way a row reaches a tool result. */
export function inlineRow(
  row: TableRow,
  select?: readonly string[],
): QueriedRow {
  const cells: Record<string, CellValue> = {};
  const oversizedCells: Array<{ columnId: string; chars: number }> = [];
  for (const [columnId, value] of Object.entries(row.cells)) {
    if (select && !select.includes(columnId)) continue;
    if (typeof value === "string" && value.length > MAX_INLINE_CELL_CHARS) {
      oversizedCells.push({ columnId, chars: value.length });
      continue;
    }
    cells[columnId] = value;
  }
  return oversizedCells.length > 0
    ? { id: row.id, cells, oversizedCells }
    : { id: row.id, cells };
}

/** Typed projection/filter/sort/offset over an in-memory table (tables are ≤ 10 000 rows; no SQL is ever generated). */
export function queryRows(
  columns: TableColumn[],
  rows: TableRow[],
  query: Omit<RowQuery, "limit"> & { offset?: number; limit?: number },
): { rows: QueriedRow[]; nextOffset: number | null; matched: number } {
  const byId = columnsById(columns);
  const columnIds = [
    ...(query.select ?? []),
    ...(query.filters ?? []).map((f) => f.columnId),
    ...(query.sort ? [query.sort.columnId] : []),
  ];
  for (const id of columnIds) requireColumn(byId, id);
  let result = filterRows(byId, rows, query.filters ?? []);
  if (query.sort) {
    const { columnId, dir } = query.sort;
    const column = requireColumn(byId, columnId);
    result = [...result].sort(
      (a, b) =>
        (a.cells[columnId] === undefined || b.cells[columnId] === undefined
          ? compareCells(a.cells[columnId], b.cells[columnId], column)
          : (dir === "asc" ? 1 : -1) *
            compareCells(a.cells[columnId], b.cells[columnId], column)) ||
        compareIds(a.id, b.id),
    );
  }
  const matched = result.length;
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 50;
  const page = result.slice(offset, offset + limit);
  return {
    rows: page.map((row) => inlineRow(row, query.select)),
    nextOffset: offset + page.length < matched ? offset + page.length : null,
    matched,
  };
}

export const listTablesTool = defineTool({
  name: "list_tables",
  kind: "read",
  capability: "content:read",
  description:
    "List tables in a project (paged, optional folder and title search). If truncated is true, lower pageSize and page through the rest.",
  inputSchema: z.object({
    projectId: z.uuid(),
    folderPath: z.array(z.string()).max(10).optional(),
    search: z.string().max(200).optional(),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(50).default(25),
  }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    const result = await listTables(
      ctx.db,
      {
        projectId: input.projectId,
        page: input.page,
        pageSize: input.pageSize,
        search: input.search,
        folderPath: input.folderPath,
        sort: "lastEditedAt",
        dir: "desc",
      },
      ctx.actor,
    );
    const mapped = result.items.map((row) => ({
      id: row.id,
      title: row.title,
      path: row.path,
      rowCount: row.rowCount,
    }));
    const { items: tables, truncated } = boundItems(mapped, newOutputBudget());
    return {
      output: { page: input.page, total: result.total, truncated, tables },
    };
  },
});

/** Column summary without option arrays (concept §4.3); list_table_column_options returns those. */
export function summarizeColumn(column: TableColumn): {
  id: string;
  name: string;
  type: ColumnType;
  optionCount?: number;
} {
  return hasOptions(column.type)
    ? {
        id: column.id,
        name: column.name,
        type: column.type,
        optionCount: (column.options ?? []).length,
      }
    : { id: column.id, name: column.name, type: column.type };
}

export const getTableTool = defineTool({
  name: "get_table",
  kind: "read",
  capability: "content:read",
  description:
    "Returns a table's title, row/column counts, a bounded column summary (id, name, type, optionCount; no option lists), and up to 5 sample rows at one snapshot. For complete data use list_table_columns, list_table_column_options, query_table_rows, or read_table_cell. commitSha equals baseCommitSha.",
  inputSchema: z.object({
    projectId: z.uuid(),
    tableId: z.uuid(),
    atCommitSha: atCommitShaInput,
  }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    const table = await getTableAtSnapshot(
      ctx.db,
      {
        projectId: input.projectId,
        tableId: input.tableId,
        atCommitSha: input.atCommitSha,
      },
      ctx.actor,
    );
    // Columns first, sharing one budget with the sample rows: a very wide
    // table degrades by dropping sample rows rather than hiding the schema.
    const budget = newPageBudget();
    const { items: columns, truncated: columnsTruncated } = boundItems(
      table.columns.map(summarizeColumn),
      budget,
    );
    const { items: sampleRows, truncated: sampleRowsTruncated } = boundItems(
      table.rows.slice(0, 5).map((row) => inlineRow(row)),
      budget,
    );
    return {
      output: {
        id: table.id,
        title: table.title,
        path: table.path,
        snapshotCommitSha: table.snapshotCommitSha,
        baseCommitSha: table.baseCommitSha,
        commitSha: table.baseCommitSha,
        columnCount: table.columns.length,
        columns,
        columnsTruncated,
        rowCount: table.rowCount,
        sampleRows,
        sampleRowsTruncated,
      },
      citations: [
        {
          kind: "table",
          projectId: input.projectId,
          tableId: table.id,
          commitSha: table.baseCommitSha,
          rowIds: [],
          columnIds: citedColumnIds(columns.map((c) => c.id)),
        },
      ],
    };
  },
});

export const queryTableRowsTool = defineTool({
  name: "query_table_rows",
  kind: "read",
  capability: "content:read",
  description:
    "Query table rows with typed filters (by column id), sorting, column projection, and cursor pagination at one snapshot; not SQL. nextCursor continues the same query; hasMore false means exhausted. Strings over 2000 chars appear under oversizedCells — fetch with read_table_cell. skipped means that row alone exceeded the budget: narrow select or use read_table_cell.",
  inputSchema: z
    .object({
      projectId: z.uuid(),
      tableId: z.uuid(),
      atCommitSha: atCommitShaInput,
      cursor: cursorInput,
    })
    .extend(rowQuerySchema.shape),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    const query = {
      select: input.select,
      filters: input.filters,
      sort: input.sort,
    };
    const pinned = resolvePinnedRequest({
      kind: "rows",
      projectId: input.projectId,
      resourceId: input.tableId,
      atCommitSha: input.atCommitSha,
      cursor: input.cursor,
      query,
    });
    const table = await getTableAtSnapshot(
      ctx.db,
      {
        projectId: input.projectId,
        tableId: input.tableId,
        atCommitSha: pinned.atCommitSha,
      },
      ctx.actor,
    );
    const page = queryRows(table.columns, table.rows, {
      ...query,
      offset: pinned.position,
      limit: input.limit,
    });
    const { items: rows, truncated } = boundItems(page.rows, newPageBudget());
    // Never an empty page with an unchanged cursor (concept §4.2): a row that
    // cannot fit alone is reported and skipped so the next page advances.
    const skipped =
      truncated && rows.length === 0 && page.rows[0]
        ? { rowId: page.rows[0].id, reason: "ROW_TOO_LARGE" as const }
        : undefined;
    const consumed = rows.length + (skipped ? 1 : 0);
    const nextPosition = truncated
      ? pinned.position + consumed
      : page.nextOffset;
    const nextCursor = continuationCursor(
      {
        kind: "rows",
        projectId: input.projectId,
        resourceId: input.tableId,
        snapshotCommitSha: table.snapshotCommitSha,
        query: pinned.query,
      },
      nextPosition !== null && nextPosition < page.matched
        ? nextPosition
        : null,
    );
    return {
      output: {
        tableId: table.id,
        snapshotCommitSha: table.snapshotCommitSha,
        baseCommitSha: table.baseCommitSha,
        commitSha: table.baseCommitSha,
        rows,
        matched: page.matched,
        nextCursor,
        hasMore: nextCursor !== null,
        truncated,
        ...(skipped ? { skipped } : {}),
      },
      citations: [
        {
          kind: "table",
          projectId: input.projectId,
          tableId: table.id,
          commitSha: table.baseCommitSha,
          rowIds: rows.slice(0, 50).map((r) => r.id),
          columnIds: citedColumnIds(
            input.select ?? table.columns.map((c) => c.id),
          ),
        },
      ],
    };
  },
});
