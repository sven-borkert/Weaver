import { describe, expect, it } from "vitest";

import type { MergeConflict } from "@weaver/core/tables/merge";
import { formatDateTimeCell } from "./datetime";
import {
  formatDiffCellValue,
  parseTableConflicts,
  presentTableConflicts,
  presentTableDiff,
} from "./presentation";
import type { TableDiff } from "@weaver/core/tables/diff";
import type { TableColumn, TableRow } from "@weaver/core/tables/types";

const ROW_1 = "11111111-1111-4111-8111-111111111111";
const ROW_2 = "22222222-2222-4222-8222-222222222222";
const COLUMN_AMOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COLUMN_NOTES = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const columns: TableColumn[] = [
  { id: COLUMN_AMOUNT, name: "Amount", type: "number" },
  { id: COLUMN_NOTES, name: "Notes", type: "text" },
];
const rows: TableRow[] = [
  { id: ROW_1, cells: { [COLUMN_AMOUNT]: 42 } },
  { id: ROW_2, cells: { [COLUMN_NOTES]: "Later" } },
];

describe("parseTableConflicts", () => {
  it("accepts every exported conflict descriptor shape", () => {
    const value: unknown = [
      { kind: "title" },
      { kind: "column", columnId: COLUMN_AMOUNT },
      { kind: "row", rowId: ROW_1 },
      { kind: "cell", rowId: ROW_2, columnId: COLUMN_NOTES },
    ];

    expect(parseTableConflicts(value)).toEqual(value);
  });

  it.each([
    null,
    [],
    { kind: "title" },
    [{ kind: "unknown" }],
    [{ kind: "column" }],
    [{ kind: "column", columnId: 1 }],
    [{ kind: "column", columnId: "" }],
    [{ kind: "column", columnId: COLUMN_AMOUNT.toUpperCase() }],
    [{ kind: "column", columnId: "amount" }],
    [{ kind: "row", rowId: null }],
    [{ kind: "row", rowId: "" }],
    [{ kind: "cell", rowId: ROW_1 }],
    [{ kind: "cell", rowId: ROW_1, columnId: "not-a-uuid" }],
    [{ kind: "title" }, { kind: "row", rowId: "not-a-uuid" }],
  ])("rejects malformed formatter data %#", (value) => {
    expect(parseTableConflicts(value)).toBeNull();
  });
});

describe("presentTableConflicts", () => {
  it("presents title conflicts", () => {
    expect(presentTableConflicts([{ kind: "title" }], columns, rows)).toEqual([
      {
        kind: "title",
        heading: "Title",
        items: ["Title changed in both versions"],
      },
    ]);
  });

  it("presents column conflicts with current names and safe fallbacks", () => {
    const conflicts: MergeConflict[] = [
      { kind: "column", columnId: COLUMN_AMOUNT },
      {
        kind: "column",
        columnId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      },
    ];

    expect(presentTableConflicts(conflicts, columns, rows)).toEqual([
      {
        kind: "columns",
        heading: "Columns",
        items: [
          "Amount changed in both versions",
          "Column ccccccc changed in both versions",
        ],
      },
    ]);
  });

  it("presents row conflicts by current position and unknown-id fallback", () => {
    const conflicts: MergeConflict[] = [
      { kind: "row", rowId: ROW_2 },
      { kind: "row", rowId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
    ];

    expect(presentTableConflicts(conflicts, columns, rows)).toEqual([
      {
        kind: "rows",
        heading: "Rows",
        items: [
          "Row 2 changed in both versions",
          "Row ddddddd changed in both versions",
        ],
      },
    ]);
  });

  it("presents cell conflicts without crashing on unknown ids", () => {
    const conflicts: MergeConflict[] = [
      { kind: "cell", rowId: ROW_1, columnId: COLUMN_AMOUNT },
      {
        kind: "cell",
        rowId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        columnId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      },
    ];

    expect(presentTableConflicts(conflicts, columns, rows)).toEqual([
      {
        kind: "cells",
        heading: "Cells",
        items: ["Row 1 · Amount", "Row eeeeeee · Column fffffff"],
      },
    ]);
  });

  it("groups mixed descriptors in title, column, row, and cell order", () => {
    const conflicts: MergeConflict[] = [
      { kind: "cell", rowId: ROW_1, columnId: COLUMN_AMOUNT },
      { kind: "row", rowId: ROW_2 },
      { kind: "title" },
      { kind: "column", columnId: COLUMN_NOTES },
    ];

    expect(
      presentTableConflicts(conflicts, columns, rows).map(({ kind }) => kind),
    ).toEqual(["title", "columns", "rows", "cells"]);
  });
});

describe("presentTableDiff", () => {
  const COLUMN_STATUS = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const COLUMN_ACTIVE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const COLUMN_DOCUMENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const COLUMN_LEGACY = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const OPTION_OPEN = "33333333-3333-4333-8333-333333333333";
  const OPTION_DONE = "44444444-4444-4444-8444-444444444444";
  const DOCUMENT_1 = "55555555-5555-4555-8555-555555555555";
  const DOCUMENT_2 = "66666666-6666-4666-8666-666666666666";

  const diffColumns: TableColumn[] = [
    { id: COLUMN_AMOUNT, name: "Total", type: "text" },
    {
      id: COLUMN_STATUS,
      name: "Status",
      type: "select",
      options: [
        { id: OPTION_OPEN, label: "Open" },
        { id: OPTION_DONE, label: "Done" },
      ],
    },
    { id: COLUMN_ACTIVE, name: "Active", type: "boolean" },
    { id: COLUMN_DOCUMENT, name: "Source", type: "document" },
  ];

  it("groups every structured table change in stable display order", () => {
    const diff: TableDiff = {
      titleChange: { from: "Old title", to: "Current title" },
      columnChanges: [
        { kind: "added", column: diffColumns[1]! },
        {
          kind: "removed",
          column: { id: COLUMN_LEGACY, name: "Legacy", type: "text" },
        },
        {
          kind: "renamed",
          columnId: COLUMN_AMOUNT,
          from: "Amount",
          to: "Total",
        },
        {
          kind: "retyped",
          columnId: COLUMN_AMOUNT,
          from: "number",
          to: "text",
        },
        { kind: "options", columnId: COLUMN_STATUS },
      ],
      columnsReordered: false,
      rowsReordered: false,
      addedRows: [ROW_2],
      removedRows: [ROW_1],
      changedCells: [
        {
          rowId: ROW_1,
          columnId: COLUMN_STATUS,
          from: OPTION_OPEN,
          to: OPTION_DONE,
        },
        {
          rowId: ROW_1,
          columnId: COLUMN_ACTIVE,
          from: true,
          to: false,
        },
        {
          rowId: ROW_2,
          columnId: COLUMN_DOCUMENT,
          from: DOCUMENT_1,
          to: DOCUMENT_2,
        },
      ],
    };

    expect(presentTableDiff(diff, diffColumns)).toEqual([
      {
        kind: "title",
        heading: "Title",
        items: ["Old title → Current title"],
      },
      {
        kind: "columns",
        heading: "Columns",
        items: [
          "Added Status (select)",
          "Removed Legacy (text)",
          "Renamed Amount → Total",
          "Retyped Total: number → text",
          "Options changed for Status",
        ],
      },
      {
        kind: "rows",
        heading: "Rows",
        items: ["Added Row 2222222", "Removed Row 1111111"],
      },
      {
        kind: "cells",
        heading: "Cells",
        items: [
          "Row 1111111 · Status: Open → Done",
          "Row 1111111 · Active: Yes → No",
          "Row 2222222 · Source: Document 5555555 → Document 6666666",
        ],
      },
    ]);
  });

  it("returns no display groups for an empty structured diff", () => {
    expect(
      presentTableDiff(
        {
          titleChange: null,
          columnChanges: [],
          columnsReordered: false,
          rowsReordered: false,
          addedRows: [],
          removedRows: [],
          changedCells: [],
        },
        diffColumns,
      ),
    ).toEqual([]);
  });

  it("shows reordering so an order-only diff is not presented as identical", () => {
    expect(
      presentTableDiff(
        {
          titleChange: null,
          columnChanges: [],
          columnsReordered: true,
          rowsReordered: true,
          addedRows: [],
          removedRows: [],
          changedCells: [],
        },
        diffColumns,
      ),
    ).toEqual([
      { kind: "columns", heading: "Columns", items: ["Column order changed"] },
      { kind: "rows", heading: "Rows", items: ["Row order changed"] },
    ]);
  });

  it("formats changed cells with removed select and document metadata", () => {
    const REMOVED_SELECT = "77777777-7777-4777-8777-777777777777";
    const REMOVED_DOCUMENT = "88888888-8888-4888-8888-888888888888";
    const ARCHIVED_OPTION = "99999999-9999-4999-8999-999999999999";
    const removedSelect: TableColumn = {
      id: REMOVED_SELECT,
      name: "Legacy status",
      type: "select",
      options: [{ id: ARCHIVED_OPTION, label: "Archived" }],
    };
    const removedDocument: TableColumn = {
      id: REMOVED_DOCUMENT,
      name: "Legacy source",
      type: "document",
    };

    expect(
      presentTableDiff(
        {
          titleChange: null,
          columnChanges: [
            { kind: "removed", column: removedSelect },
            { kind: "removed", column: removedDocument },
          ],
          columnsReordered: false,
          rowsReordered: false,
          addedRows: [],
          removedRows: [],
          changedCells: [
            {
              rowId: ROW_1,
              columnId: REMOVED_SELECT,
              from: ARCHIVED_OPTION,
              to: null,
            },
            {
              rowId: ROW_1,
              columnId: REMOVED_DOCUMENT,
              from: DOCUMENT_1,
              to: null,
            },
          ],
        },
        [],
      ),
    ).toEqual([
      {
        kind: "columns",
        heading: "Columns",
        items: [
          "Removed Legacy status (select)",
          "Removed Legacy source (document)",
        ],
      },
      {
        kind: "cells",
        heading: "Cells",
        items: [
          "Row 1111111 · Legacy status: Archived → Empty",
          "Row 1111111 · Legacy source: Document 5555555 → Empty",
        ],
      },
    ]);
  });

  it("formats each changed-cell side with its retype direction", () => {
    const SELECT_TO_TEXT = "12121212-1212-4121-8121-121212121212";
    const TEXT_TO_SELECT = "34343434-3434-4343-8343-343434343434";
    const HISTORICAL_OPTION = "56565656-5656-4565-8565-565656565656";
    const CURRENT_OPTION = "78787878-7878-4787-8787-787878787878";
    const currentColumns: TableColumn[] = [
      {
        id: SELECT_TO_TEXT,
        name: "Legacy status",
        type: "text",
      },
      {
        id: TEXT_TO_SELECT,
        name: "Current status",
        type: "select",
        options: [{ id: CURRENT_OPTION, label: "Ready" }],
      },
    ];

    expect(
      presentTableDiff(
        {
          titleChange: null,
          columnChanges: [
            {
              kind: "retyped",
              columnId: SELECT_TO_TEXT,
              from: "select",
              to: "text",
            },
            {
              kind: "retyped",
              columnId: TEXT_TO_SELECT,
              from: "text",
              to: "select",
            },
          ],
          columnsReordered: false,
          rowsReordered: false,
          addedRows: [],
          removedRows: [],
          changedCells: [
            {
              rowId: ROW_1,
              columnId: SELECT_TO_TEXT,
              from: HISTORICAL_OPTION,
              to: "Archived",
            },
            {
              rowId: ROW_1,
              columnId: TEXT_TO_SELECT,
              from: "Ready",
              to: CURRENT_OPTION,
            },
          ],
        },
        currentColumns,
      ),
    ).toEqual([
      {
        kind: "columns",
        heading: "Columns",
        items: [
          "Retyped Legacy status: select → text",
          "Retyped Current status: text → select",
        ],
      },
      {
        kind: "cells",
        heading: "Cells",
        items: [
          "Row 1111111 · Legacy status: Option 5656565 → Archived",
          "Row 1111111 · Current status: Ready → Ready",
        ],
      },
    ]);
  });
});

describe("formatDiffCellValue for multiselect and datetime", () => {
  const COLUMN_TAGS = "12121212-1212-4121-8121-121212121212";
  const OPTION_A = "34343434-3434-4343-8343-343434343434";
  const OPTION_B = "56565656-5656-4565-8565-565656565656";
  const tagsColumn: TableColumn = {
    id: COLUMN_TAGS,
    name: "Tags",
    type: "multiselect",
    options: [
      { id: OPTION_A, label: "Alpha" },
      { id: OPTION_B, label: "Beta" },
    ],
  };
  const COLUMN_WHEN = "78787878-7878-4787-8787-787878787878";
  const whenColumn: TableColumn = {
    id: COLUMN_WHEN,
    name: "When",
    type: "datetime",
  };

  it("joins multiselect option labels with a comma", () => {
    expect(formatDiffCellValue([OPTION_A, OPTION_B], tagsColumn)).toBe(
      "Alpha, Beta",
    );
  });

  it("falls back to the raw id for an unknown multiselect option", () => {
    expect(formatDiffCellValue([OPTION_A, ROW_1], tagsColumn)).toBe(
      `Alpha, ${ROW_1}`,
    );
  });

  it("renders a datetime cell through formatDateTimeCell", () => {
    const cell = "2026-09-18T12:30:00Z";
    expect(formatDiffCellValue(cell, whenColumn)).toBe(
      formatDateTimeCell(cell),
    );
  });
});

describe("formatDiffCellValue for longtext and url", () => {
  const COLUMN_NOTES = "23232323-2323-4232-8232-232323232323";
  const notesColumn: TableColumn = {
    id: COLUMN_NOTES,
    name: "Notes",
    type: "longtext",
  };
  const COLUMN_LINK = "45454545-4545-4545-8545-454545454545";
  const linkColumn: TableColumn = {
    id: COLUMN_LINK,
    name: "Link",
    type: "url",
  };

  it("truncates a longtext cell to its first line", () => {
    expect(formatDiffCellValue("First line\nSecond line", notesColumn)).toBe(
      "First line…",
    );
  });

  it("truncates a longtext cell without a newline at ~120 chars", () => {
    const long = "a".repeat(200);
    const result = formatDiffCellValue(long, notesColumn);
    expect(result).toBe(`${"a".repeat(120)}…`);
  });

  it("leaves a short single-line longtext cell untouched", () => {
    expect(formatDiffCellValue("Short note", notesColumn)).toBe("Short note");
  });

  it("truncates a long url cell the same way", () => {
    const long = `https://example.test/${"a".repeat(200)}`;
    const result = formatDiffCellValue(long, linkColumn);
    expect(result).toBe(`${long.slice(0, 120)}…`);
  });

  it("leaves a short url cell untouched", () => {
    expect(formatDiffCellValue("https://example.test/path", linkColumn)).toBe(
      "https://example.test/path",
    );
  });
});
