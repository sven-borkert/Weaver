import { describe, expect, it } from "vitest";

import { coerceGridValue, toGridColumnDefs, toGridRows } from "./grid";
import type { TableColumn, TableRow } from "@weaver/core/tables/types";

const TEXT_ID = "11111111-1111-4111-8111-111111111111";
const NUMBER_ID = "22222222-2222-4222-8222-222222222222";
const DATE_ID = "33333333-3333-4333-8333-333333333333";
const SELECT_ID = "44444444-4444-4444-8444-444444444444";
const BOOLEAN_ID = "55555555-5555-4555-8555-555555555555";
const DOCUMENT_ID = "66666666-6666-4666-8666-666666666666";
const OPTION_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_OPTION_ID = "88888888-8888-4888-8888-888888888888";
const ROW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DATETIME_ID = "99999999-9999-4999-8999-999999999999";
const MULTISELECT_ID = "b1111111-1111-4111-8111-111111111111";
const URL_ID = "c2222222-2222-4222-8222-222222222222";
const LONGTEXT_ID = "d3333333-3333-4333-8333-333333333333";

const columns: TableColumn[] = [
  { id: TEXT_ID, name: "Text", type: "text" },
  { id: NUMBER_ID, name: "Number", type: "number" },
  { id: DATE_ID, name: "Date", type: "date" },
  {
    id: SELECT_ID,
    name: "Status",
    type: "select",
    options: [
      { id: OPTION_ID, label: "Open" },
      { id: OTHER_OPTION_ID, label: "Done" },
    ],
  },
  { id: BOOLEAN_ID, name: "Complete", type: "boolean" },
  { id: DOCUMENT_ID, name: "Document", type: "document" },
];

const extraColumns: TableColumn[] = [
  { id: DATETIME_ID, name: "When", type: "datetime" },
  {
    id: MULTISELECT_ID,
    name: "Tags",
    type: "multiselect",
    options: [
      { id: OPTION_ID, label: "Open" },
      { id: OTHER_OPTION_ID, label: "Done" },
    ],
  },
  { id: URL_ID, name: "Link", type: "url" },
  { id: LONGTEXT_ID, name: "Notes", type: "longtext" },
];

describe("toGridRows", () => {
  it("keeps the canonical row id separate from sparse cell keys", () => {
    const rows: TableRow[] = [
      {
        id: ROW_ID,
        cells: { [TEXT_ID]: "Alpha", [BOOLEAN_ID]: false },
      },
    ];

    expect(toGridRows(rows)).toEqual([
      {
        __rowId: ROW_ID,
        [TEXT_ID]: "Alpha",
        [BOOLEAN_ID]: false,
      },
    ]);
    expect(rows).toEqual([
      {
        id: ROW_ID,
        cells: { [TEXT_ID]: "Alpha", [BOOLEAN_ID]: false },
      },
    ]);
  });
});

describe("toGridColumnDefs", () => {
  it("maps all six canonical types to their Community editors and filters", () => {
    expect(
      toGridColumnDefs(columns, true).map((definition) => ({
        colId: definition.colId,
        editable: definition.editable,
        filter: definition.filter as unknown,
        cellEditor: definition.cellEditor as unknown,
        cellDataType: definition.cellDataType,
      })),
    ).toEqual([
      {
        colId: TEXT_ID,
        editable: true,
        filter: "agTextColumnFilter",
        cellEditor: "agTextCellEditor",
        cellDataType: "text",
      },
      {
        colId: NUMBER_ID,
        editable: true,
        filter: "agNumberColumnFilter",
        cellEditor: "agNumberCellEditor",
        cellDataType: "number",
      },
      {
        colId: DATE_ID,
        editable: true,
        filter: "agDateColumnFilter",
        cellEditor: "agDateStringCellEditor",
        cellDataType: "dateString",
      },
      {
        colId: SELECT_ID,
        editable: true,
        filter: "agTextColumnFilter",
        cellEditor: "agSelectCellEditor",
        cellDataType: false,
      },
      {
        colId: BOOLEAN_ID,
        editable: true,
        filter: false,
        cellEditor: "agCheckboxCellEditor",
        cellDataType: "boolean",
      },
      {
        colId: DOCUMENT_ID,
        editable: true,
        filter: "agTextColumnFilter",
        cellEditor: "documentCellEditor",
        cellDataType: false,
      },
    ]);
  });

  it("preserves canonical identifiers and common column behavior", () => {
    expect(
      toGridColumnDefs(columns, true).map((definition) => ({
        field: definition.field,
        colId: definition.colId,
        headerName: definition.headerName,
        sortable: definition.sortable,
        resizable: definition.resizable,
      })),
    ).toEqual(
      columns.map((column) => ({
        field: column.id,
        colId: column.id,
        headerName: column.name,
        sortable: true,
        resizable: true,
      })),
    );
  });

  it("makes every Viewer column non-editable", () => {
    expect(
      toGridColumnDefs(columns, false).map(({ editable }) => editable),
    ).toEqual([false, false, false, false, false, false]);
  });
});

describe("coerceGridValue", () => {
  it("accepts only strings for text cells", () => {
    expect(coerceGridValue(columns[0]!, "Alpha")).toEqual({
      ok: true,
      value: "Alpha",
    });
    expect(coerceGridValue(columns[0]!, 42)).toEqual({ ok: false });
  });

  it("coerces finite numeric editor input and rejects non-finite values", () => {
    expect(coerceGridValue(columns[1]!, " 12.5 ")).toEqual({
      ok: true,
      value: 12.5,
    });
    expect(coerceGridValue(columns[1]!, -4)).toEqual({
      ok: true,
      value: -4,
    });
    expect(coerceGridValue(columns[1]!, Number.NaN)).toEqual({ ok: false });
    expect(coerceGridValue(columns[1]!, Number.POSITIVE_INFINITY)).toEqual({
      ok: false,
    });
    expect(coerceGridValue(columns[1]!, "not a number")).toEqual({
      ok: false,
    });
  });

  it("accepts valid ISO dates and rejects impossible or malformed dates", () => {
    expect(coerceGridValue(columns[2]!, "2026-08-29")).toEqual({
      ok: true,
      value: "2026-08-29",
    });
    expect(coerceGridValue(columns[2]!, "2026-02-29")).toEqual({ ok: false });
    expect(coerceGridValue(columns[2]!, "29.08.2026")).toEqual({ ok: false });
  });

  it("accepts only configured select option ids", () => {
    expect(coerceGridValue(columns[3]!, OPTION_ID)).toEqual({
      ok: true,
      value: OPTION_ID,
    });
    expect(coerceGridValue(columns[3]!, ROW_ID)).toEqual({ ok: false });
    expect(coerceGridValue(columns[3]!, "Open")).toEqual({ ok: false });
  });

  it("accepts booleans without string coercion", () => {
    expect(coerceGridValue(columns[4]!, true)).toEqual({
      ok: true,
      value: true,
    });
    expect(coerceGridValue(columns[4]!, false)).toEqual({
      ok: true,
      value: false,
    });
    expect(coerceGridValue(columns[4]!, "false")).toEqual({ ok: false });
  });

  it("accepts only canonical document UUIDs", () => {
    expect(coerceGridValue(columns[5]!, ROW_ID)).toEqual({
      ok: true,
      value: ROW_ID,
    });
    expect(coerceGridValue(columns[5]!, "not-a-document-id")).toEqual({
      ok: false,
    });
  });

  it.each([undefined, null, ""])(
    "stores a cleared editor value (%s) as an absent sparse cell",
    (value) => {
      for (const column of columns) {
        expect(coerceGridValue(column, value)).toEqual({
          ok: true,
          value: undefined,
        });
      }
    },
  );
});

describe("toGridColumnDefs for datetime/multiselect/url/longtext", () => {
  it("assigns the dedicated cell editors and data types for the four new types", () => {
    expect(
      toGridColumnDefs(extraColumns, true).map((definition) => ({
        colId: definition.colId,
        cellEditor: definition.cellEditor as unknown,
        cellEditorPopup: definition.cellEditorPopup,
        cellDataType: definition.cellDataType,
      })),
    ).toEqual([
      {
        colId: DATETIME_ID,
        cellEditor: "dateTimeCellEditor",
        cellEditorPopup: undefined,
        cellDataType: "text",
      },
      {
        colId: MULTISELECT_ID,
        cellEditor: "multiselectCellEditor",
        cellEditorPopup: true,
        cellDataType: "object",
      },
      {
        colId: URL_ID,
        cellEditor: "agTextCellEditor",
        cellEditorPopup: undefined,
        cellDataType: "text",
      },
      {
        colId: LONGTEXT_ID,
        cellEditor: "agLargeTextCellEditor",
        cellEditorPopup: true,
        cellDataType: "text",
      },
    ]);
  });

  it("caps the longtext editor at the shared text limit", () => {
    const [column] = toGridColumnDefs(
      [{ id: LONGTEXT_ID, name: "Notes", type: "longtext" }],
      true,
    );
    expect(column?.cellEditorParams).toEqual({
      maxLength: 10_000,
      rows: 10,
      cols: 60,
    });
  });

  it("formats a multiselect value as joined option labels", () => {
    const column = toGridColumnDefs(extraColumns, true)[1];
    const valueFormatter = column?.valueFormatter;
    expect(
      typeof valueFormatter === "function"
        ? valueFormatter({
            value: [OPTION_ID, OTHER_OPTION_ID],
          } as Parameters<typeof valueFormatter>[0])
        : undefined,
    ).toBe("Open, Done");
  });
});

describe("coerceGridValue for datetime/multiselect/url/longtext", () => {
  const datetimeColumn = extraColumns[0]!;
  const multiselectColumn = extraColumns[1]!;
  const urlColumn = extraColumns[2]!;
  const longtextColumn = extraColumns[3]!;

  it("normalizes a valid datetime cell and rejects an invalid one", () => {
    expect(coerceGridValue(datetimeColumn, "2026-09-18T14:30+02:00")).toEqual({
      ok: true,
      value: "2026-09-18T14:30:00+02:00",
    });
    expect(coerceGridValue(datetimeColumn, "not-a-datetime")).toEqual({
      ok: false,
    });
  });

  it("rejects a url without an http(s) scheme and accepts a valid one", () => {
    expect(coerceGridValue(urlColumn, "x")).toEqual({ ok: false });
    expect(coerceGridValue(urlColumn, "https://x.test")).toEqual({
      ok: true,
      value: "https://x.test",
    });
  });

  it("accepts longtext up to the shared cap and rejects beyond it", () => {
    expect(coerceGridValue(longtextColumn, "hello")).toEqual({
      ok: true,
      value: "hello",
    });
    expect(coerceGridValue(longtextColumn, "a".repeat(10_001))).toEqual({
      ok: false,
    });
  });

  it("accepts known option ids and clears on an empty selection", () => {
    expect(coerceGridValue(multiselectColumn, [OPTION_ID])).toEqual({
      ok: true,
      value: [OPTION_ID],
    });
    expect(coerceGridValue(multiselectColumn, [])).toEqual({
      ok: true,
      value: undefined,
    });
    expect(coerceGridValue(multiselectColumn, [ROW_ID])).toEqual({
      ok: false,
    });
  });
});

it("clears whitespace-only numeric input", () => {
  expect(
    coerceGridValue({ id: "number", name: "Number", type: "number" }, "   "),
  ).toEqual({ ok: true, value: undefined });
});

it("includes a sparse empty option in select editors", () => {
  const [column] = toGridColumnDefs(
    [
      {
        id: "select",
        name: "Select",
        type: "select",
        options: [{ id: "option", label: "Choice" }],
      },
    ],
    true,
  );
  expect(column?.cellEditorParams).toEqual({ values: ["", "option"] });
});
