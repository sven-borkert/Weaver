import { describe, expect, it } from "vitest";
import {
  TableFileError,
  parseRows,
  parseSchemaFile,
  serializeRows,
  serializeSchemaFile,
  serializedRowBytes,
} from "./jsonl";
import type { SchemaFile, TableColumn, TableRow } from "./types";

const COL_TEXT: TableColumn = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Item",
  type: "text",
};
const COL_NUM: TableColumn = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Qty",
  type: "number",
};
const COL_SEL: TableColumn = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "State",
  type: "select",
  options: [{ id: "44444444-4444-4444-8444-444444444444", label: "Open" }],
};

const ROW_A: TableRow = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  cells: { [COL_TEXT.id]: "milk", [COL_NUM.id]: 2 },
};
const ROW_B: TableRow = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  cells: {},
};

describe("jsonl rows", () => {
  it("serializes one object per line with cells in column order, sparse", () => {
    const text = serializeRows([COL_NUM, COL_TEXT], [ROW_A, ROW_B]);
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      `{"id":"${ROW_A.id}","cells":{"${COL_NUM.id}":2,"${COL_TEXT.id}":"milk"}}`,
    );
    expect(lines[1]).toBe(`{"id":"${ROW_B.id}","cells":{}}`);
    expect(text.endsWith("\n")).toBe(true);
    expect(serializeRows([COL_TEXT], [])).toBe("");
  });

  it.each<{ name: string; cells: TableRow["cells"] }>([
    { name: "no cells", cells: {} },
    { name: "one empty text cell", cells: { [COL_TEXT.id]: "" } },
    {
      name: "escapes and non-ASCII",
      cells: {
        [COL_TEXT.id]: 'a"b\\c\n\t\u0001 é 日本 😀 \ud800',
        [COL_NUM.id]: -1.5e21,
      },
    },
    {
      name: "number, boolean, and multiselect",
      cells: {
        [COL_NUM.id]: 0.1,
        [COL_TEXT.id]: true,
        [COL_SEL.id]: ["44444444-4444-4444-8444-444444444444", "ü"],
      },
    },
    {
      name: "an omitted middle cell",
      cells: { [COL_TEXT.id]: "x", [COL_SEL.id]: [] },
    },
  ])("sizes a row exactly as serialized: $name", ({ cells }) => {
    const columns = [COL_TEXT, COL_NUM, COL_SEL];
    const rows = [
      { id: ROW_A.id, cells },
      { id: ROW_B.id, cells },
    ];
    const present = columns
      .map((column) => cells[column.id])
      .filter((value) => value !== undefined);
    expect(2 * serializedRowBytes(present)).toBe(
      Buffer.byteLength(serializeRows(columns, rows), "utf8"),
    );
  });

  it("round-trips rows losslessly", () => {
    const rows = [ROW_A, ROW_B];
    expect(parseRows(serializeRows([COL_NUM, COL_TEXT], rows))).toEqual(rows);
  });

  it("drops cells for unknown column ids on serialize", () => {
    const row: TableRow = {
      id: ROW_A.id,
      cells: { "99999999-9999-4999-8999-999999999999": "ghost" },
    };
    expect(serializeRows([COL_TEXT], [row])).toBe(
      `{"id":"${ROW_A.id}","cells":{}}\n`,
    );
  });

  it("rejects malformed lines, duplicate ids, and non-scalar cells", () => {
    expect(() => parseRows("not json\n")).toThrow(TableFileError);
    expect(() => parseRows(`{"id":"x","cells":{}}\n`)).toThrow(TableFileError);
    expect(() =>
      parseRows(
        `{"id":"${ROW_A.id}","cells":{}}\n{"id":"${ROW_A.id}","cells":{}}\n`,
      ),
    ).toThrow(TableFileError);
    expect(() =>
      parseRows(`{"id":"${ROW_A.id}","cells":{"${COL_TEXT.id}":[1]}}\n`),
    ).toThrow(TableFileError);
    expect(() =>
      parseRows(`{"id":"${ROW_A.id}","cells":{},"extra":1}\n`),
    ).toThrow(TableFileError);
  });
});

describe("schema file", () => {
  const SCHEMA: SchemaFile = {
    id: "55555555-5555-4555-8555-555555555555",
    title: "Groceries",
    sourceOfTruth: "git",
    columns: [COL_TEXT, COL_SEL],
    created: "2026-08-28T10:00:00.000Z",
    updated: "2026-08-28T10:00:00.000Z",
  };

  it("roundtrips_legacy_and_styled_document_folder_table", () => {
    expect(parseSchemaFile(serializeSchemaFile(SCHEMA))).not.toHaveProperty(
      "appearance",
    );
    const styled = {
      ...SCHEMA,
      appearance: {
        backgroundColor: "#AABBCC",
        icon: {
          type: "image" as const,
          digest: "a".repeat(64),
          extension: "png" as const,
        },
      },
    };
    const parsed = parseSchemaFile(serializeSchemaFile(styled));
    expect(parsed).toEqual({
      ...styled,
      appearance: { ...styled.appearance, backgroundColor: "#aabbcc" },
    });
    expect(parseRows(serializeRows([COL_TEXT, COL_NUM], [ROW_A]))).toEqual([
      ROW_A,
    ]);
  });
  it("drops_bad_optional_appearance_without_dropping_content", () => {
    expect(
      parseSchemaFile(
        JSON.stringify({ ...SCHEMA, appearance: { backgroundColor: "red" } }),
      ),
    ).toEqual(SCHEMA);
    expect(serializeSchemaFile({ ...SCHEMA, appearance: {} })).toBe(
      serializeSchemaFile(SCHEMA),
    );
    expect(() =>
      parseSchemaFile(
        JSON.stringify({ ...SCHEMA, appearance: {}, unknown: true }),
      ),
    ).toThrow(TableFileError);
  });
  it("round-trips schema files losslessly", () => {
    const text = serializeSchemaFile(SCHEMA);
    expect(text.endsWith("\n")).toBe(true);
    expect(parseSchemaFile(text)).toEqual(SCHEMA);
  });

  it("rejects invalid schema files", () => {
    expect(() => parseSchemaFile("nope")).toThrow(TableFileError);
    expect(() => parseSchemaFile(`{"id":"x"}`)).toThrow(TableFileError);
    expect(() =>
      parseSchemaFile(JSON.stringify({ ...SCHEMA, created: "not-a-date" })),
    ).toThrow(TableFileError);
    expect(() =>
      parseSchemaFile(
        JSON.stringify({ ...SCHEMA, updated: "2026-02-30T10:00:00.000Z" }),
      ),
    ).toThrow(TableFileError);
    expect(() =>
      parseSchemaFile(JSON.stringify({ ...SCHEMA, sourceOfTruth: "db" })),
    ).toThrow(TableFileError);
    expect(() =>
      parseSchemaFile(
        JSON.stringify({
          ...SCHEMA,
          columns: [{ ...COL_TEXT, type: "emoji" }],
        }),
      ),
    ).toThrow(TableFileError);
    expect(() =>
      parseSchemaFile(
        JSON.stringify({
          ...SCHEMA,
          columns: [{ id: COL_TEXT.id, name: "S", type: "select" }],
        }),
      ),
    ).toThrow(TableFileError);
  });
});
