import { describe, expect, it } from "vitest";
import { readCsv, readCsvOverview, searchCsv } from "./csv";

const bytes = (text: string) => Buffer.from(text);
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe("original CSV reads", () => {
  it("quoted_multiline_and_escaped_quotes_keep_strings", () => {
    const data = bytes(
      '\ufeffid,note\r\n001,"first\r\nsecond ""quote"""\r\n002,end\n',
    );
    const result = readCsv(data, {});
    expect(result.rows).toEqual([
      {
        row: 1,
        startLine: 2,
        endLine: 3,
        width: 2,
        cells: [
          { index: 0, value: "001", truncated: false },
          { index: 1, value: 'first\r\nsecond "quote"', truncated: false },
        ],
        omittedCellCount: 0,
      },
      {
        row: 2,
        startLine: 4,
        endLine: 4,
        width: 2,
        cells: [
          { index: 0, value: "002", truncated: false },
          { index: 1, value: "end", truncated: false },
        ],
        omittedCellCount: 0,
      },
    ]);
    expect(result.rowCount).toBe(2);
    expect(result.nextRow).toBeNull();
    expect(readCsv(data, { columns: [0] }).rows[0]!.cells[0]!.value).toBe(
      "001",
    );
  });

  it("duplicate_empty_headers_and_trailing_empty_cells_keep_positions", () => {
    const data = bytes("same,same,,\nx,y,,\na,b,c,d,extra,\nshort\n");
    const overview = readCsvOverview(data, {});
    expect(
      overview.columns.map(({ index, name }) => ({ index, name })),
    ).toEqual([
      { index: 0, name: "same" },
      { index: 1, name: "same" },
      { index: 2, name: "" },
      { index: 3, name: "" },
      { index: 4, name: "" },
      { index: 5, name: "" },
    ]);
    expect(overview).toMatchObject({
      rowCount: 3,
      columnCount: 6,
      irregularRowCount: 2,
    });
    const rows = readCsv(data, {}).rows;
    expect(rows[0]!.cells.map((cell) => cell.value)).toEqual([
      "x",
      "y",
      "",
      "",
    ]);
    expect(rows[1]!.cells.map((cell) => cell.value)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "extra",
      "",
    ]);
    expect(
      readCsv(data, { columns: [3, 0] }).rows[0]!.cells.map(
        (cell) => cell.index,
      ),
    ).toEqual([3, 0]);
    expect(readCsv(data, { columns: [4] }).rows[2]!.cells).toEqual([]);
  });

  it("headerless_first_row_is_data", () => {
    const result = readCsv(bytes("001,true\n002,false\n"), {
      hasHeader: false,
      limit: 1,
    });
    expect(result).toMatchObject({ hasHeader: false, rowCount: 2, nextRow: 2 });
    expect(result.rows[0]).toMatchObject({ row: 1, startLine: 1, endLine: 1 });
    expect(result.rows[0]!.cells.map((cell) => cell.value)).toEqual([
      "001",
      "true",
    ]);
    expect(result.columns.map((column) => column.name)).toEqual([
      "Column 1",
      "Column 2",
    ]);
    expect(
      readCsv(bytes("001,true\n002,false\n"), { hasHeader: false, startRow: 2 })
        .rows[0]!.row,
    ).toBe(2);
  });

  it("semicolon_tab_and_override_are_deterministic", () => {
    expect(readCsvOverview(bytes('"a,b";c\n"x,y";z'), {}).delimiter).toBe(";");
    expect(readCsvOverview(bytes('"a;b"\tc\nx\ty'), {}).delimiter).toBe("\t");
    expect(readCsvOverview(bytes("a,b;c\nx,y;z"), {}).delimiter).toBe(",");
    expect(readCsvOverview(bytes("a\nx"), {}).delimiter).toBe(",");
    expect(
      readCsv(bytes("a,b;c\nx,y;z"), { delimiter: ";" }).rows[0]!.cells.map(
        (cell) => cell.value,
      ),
    ).toEqual(["x,y", "z"]);
  });

  it("wide_or_long_row_advances_with_explicit_omissions", () => {
    const wide = Array.from(
      { length: 100_000 },
      (_, index) => `column-${index}`,
    ).join(",");
    const data = bytes(
      `${wide}\n${Array(100_000).fill("value").join(",")}\nnext\n`,
    );
    const result = readCsv(data, {});
    expect(size(result)).toBeLessThanOrEqual(128 * 1024);
    expect(result.omittedColumnCount).toBeGreaterThan(0);
    expect(result.columnCount).toBe(100_000);
    expect(result.rows[0]!.omittedCellCount).toBeGreaterThan(0);
    expect(result.rows[0]!.width).toBe(100_000);
    expect(result.nextRow).toBe(2);
    expect(readCsv(data, { startRow: result.nextRow! }).rows[0]!.row).toBe(2);
    const selected = readCsv(data, { columns: [99999] });
    expect(selected.columns[0]!.index).toBe(99999);
    expect(selected.rows[0]!.cells).toEqual([
      { index: 99999, value: "value", truncated: false },
    ]);
    const long = readCsv(bytes(`header\n${"😀".repeat(10_000)}\n`), {});
    expect(Buffer.byteLength(long.rows[0]!.cells[0]!.value)).toBe(20_000);
    expect(long.rows[0]!.cells[0]!.truncated).toBe(true);
    expect(long.rows[0]!.cells[0]!.value).not.toContain("�");
  });

  it("search_reaches_later_rows_and_long_fields", () => {
    const long = "😀".repeat(10_000);
    const data = bytes(`id,note\n001,${long}NeEdLe\n002,"needle\r\nNEEDLE"\n`);
    const first = searchCsv(data, { query: "needle", limit: 1 });
    expect(first.matches[0]).toMatchObject({
      row: 1,
      column: 1,
      charOffset: 20_000,
      startLine: 2,
      endLine: 2,
    });
    const second = searchCsv(data, {
      query: "needle",
      position: first.nextPosition!,
      limit: 1,
    });
    expect(second.matches[0]).toMatchObject({
      row: 2,
      column: 1,
      charOffset: 0,
      startLine: 3,
      endLine: 4,
    });
    const third = searchCsv(data, {
      query: "needle",
      position: second.nextPosition!,
      limit: 1,
    });
    expect(third.matches[0]!.charOffset).toBe(8);
    expect(third.nextPosition).toBeNull();
    expect(
      searchCsv(bytes('h\n"a.*a.*"'), { query: ".*" }).matches.map(
        (match) => match.charOffset,
      ),
    ).toEqual([1, 4]);
  });

  it("bounds_escaped_header_metadata_and_pages_to_the_last_column", () => {
    const count = 6000;
    const header = `"${"\u0001".repeat(30_000)}"`;
    const data = bytes(
      `${[header, ...Array.from({ length: count - 1 }, () => "name")].join(",")}\n${Array(count).fill("").join(",")}`,
    );
    const overview = readCsvOverview(data, { limit: 200 });
    expect(size(overview)).toBeLessThanOrEqual(128 * 1024);
    expect(overview.columns[0]!.nameTruncated).toBe(true);
    expect(overview.nextOffset).toBeGreaterThan(0);
    const last = readCsvOverview(data, { offset: count - 1 });
    expect(last.columns[0]!.index).toBe(count - 1);
    expect(last.nextOffset).toBeNull();
    expect(size(readCsv(data, {}))).toBeLessThanOrEqual(128 * 1024);
    const escaped = bytes(
      `${Array(200).fill(header).join(",")}\n${Array(200).fill("").join(",")}`,
    );
    const page = readCsvOverview(escaped, { limit: 200 });
    expect(size(page)).toBeLessThanOrEqual(128 * 1024);
    expect(page.nextOffset).toBeGreaterThan(0);
    expect(page.nextOffset).toBeLessThan(200);
    const escapedRow = readCsv(
      bytes(`h\n"${"\u0001".repeat(40_000)}"\nnext`),
      {},
    );
    expect(size(escapedRow)).toBeLessThanOrEqual(128 * 1024);
    expect(escapedRow.rows[0]!.cells[0]!.truncated).toBe(true);
  });

  it("searches_cells_omitted_from_the_read_window_and_preserves_unicode_snippets", () => {
    const row = `${Array(4000).fill("value").join(",")},tail-match`;
    const data = bytes(`header\n${Array(70).fill("later").join("\n")}\n${row}`);
    expect(readCsv(data, {}).rows).toHaveLength(50);
    expect(
      readCsv(data, { startRow: 71 }).rows[0]!.cells.some(
        (cell) => cell.index === 4000,
      ),
    ).toBe(false);
    expect(searchCsv(data, { query: "tail-match" }).matches[0]).toMatchObject({
      row: 71,
      column: 4000,
    });
    const match = searchCsv(bytes(`h\nHITa${"😀".repeat(81)}`), {
      query: "hit",
    }).matches[0]!;
    expect(match.snippet).toBe(`HITa${"😀".repeat(39)}`);
  });

  it("does_not_apply_table_import_row_caps_or_type_inference", () => {
    const data = bytes(`id\n${Array(12_001).fill("001").join("\n")}`);
    expect(readCsvOverview(data, {}).rowCount).toBe(12_001);
    expect(readCsv(data, { startRow: 12_001 }).rows[0]!.cells[0]!.value).toBe(
      "001",
    );
  });

  it("budgets_projected_empty_rows_and_continues_without_skips_or_duplicates", () => {
    const first = [
      "x",
      ...Array.from({ length: 6 }, () => "a".repeat(20_000)),
      "b".repeat(9_500),
    ].join(",");
    const data = bytes(
      `h0,h1,h2,h3,h4,h5,h6,h7\n${first}\n${Array(199).fill("short").join("\n")}`,
    );
    const columns = [1, 2, 3, 4, 5, 6, 7];
    const initial = readCsv(data, { columns, limit: 200 });
    expect(size(initial)).toBeLessThanOrEqual(128 * 1024);
    expect(initial.nextRow).not.toBeNull();
    expect(initial.rows[0]!.cells).toEqual(
      columns.map((index) => ({
        index,
        value: index === 7 ? "b".repeat(9_500) : "a".repeat(20_000),
        truncated: false,
      })),
    );
    expect(initial.rows[0]!).toMatchObject({
      row: 1,
      width: 8,
      omittedCellCount: 1,
    });
    const reconstructed = [...initial.rows];
    let cursor = initial.nextRow;
    let pages = 1;
    while (cursor !== null) {
      const result = readCsv(data, { columns, limit: 200, startRow: cursor });
      expect(size(result)).toBeLessThanOrEqual(128 * 1024);
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows[0]!.row).toBe(cursor);
      reconstructed.push(...result.rows);
      if (result.nextRow !== null)
        expect(result.nextRow).toBeGreaterThan(cursor);
      cursor = result.nextRow;
      pages++;
      expect(pages).toBeLessThanOrEqual(200);
    }
    expect(reconstructed.map((row) => row.row)).toEqual(
      Array.from({ length: 200 }, (_, index) => index + 1),
    );
    expect(reconstructed.slice(1)).toEqual(
      Array.from({ length: 199 }, (_, index) => ({
        row: index + 2,
        startLine: index + 3,
        endLine: index + 3,
        width: 1,
        cells: [],
        omittedCellCount: 1,
      })),
    );
  });

  it("does_not_fabricate_records_for_empty_sources_or_terminal_newlines", () => {
    expect(readCsvOverview(bytes(""), {})).toMatchObject({
      rowCount: 0,
      columnCount: 0,
      columns: [],
    });
    expect(readCsvOverview(bytes("\ufeff"), {})).toMatchObject({
      rowCount: 0,
      columnCount: 0,
    });
    expect(readCsv(bytes("h\n"), {}).rows).toEqual([]);
    expect(readCsv(bytes("\n"), { hasHeader: false }).rows).toHaveLength(1);
    expect(
      readCsv(bytes("h\rblank\r\r"), {}).rows.map((row) => [
        row.startLine,
        row.endLine,
      ]),
    ).toEqual([
      [2, 2],
      [3, 3],
    ]);
  });

  it("uses_safe_fixed_malformed_errors", () => {
    for (const source of ['h\n"secret', 'h\n"secret"tail', 'h\nsec"ret']) {
      expect(() => readCsv(bytes(source), {})).toThrow(
        "CSV contains malformed quoting",
      );
      expect(() => searchCsv(bytes(source), { query: "x" })).toThrow(
        "CSV contains malformed quoting",
      );
    }
    expect(() => readCsv(Uint8Array.from([0xff]), {})).toThrow(
      "artifact is not valid UTF-8",
    );
  });

  it("validates_limits_indices_positions_and_ranges", () => {
    const data = bytes("h\n😀hit\n");
    for (const input of [
      { limit: 0 },
      { limit: 201 },
      { startRow: 0 },
      { startRow: 1.5 },
      { columns: [-1] },
      { columns: [1] },
      { columns: [0, 0] },
      { columns: [] },
    ]) {
      expect(() => readCsv(data, input)).toThrow();
    }
    expect(readCsv(data, { startRow: 2 }).rows).toEqual([]);
    expect(() => readCsv(data, { startRow: 3 })).toThrow();
    expect(() => readCsvOverview(data, { offset: -1 })).toThrow();
    expect(() => readCsvOverview(data, { limit: 201 })).toThrow();
    expect(() => readCsv(data, { delimiter: "|" as "," })).toThrow();
    expect(() => searchCsv(data, { query: "" })).toThrow();
    expect(() =>
      searchCsv(data, {
        query: "hit",
        position: { row: 1, column: 0, charOffset: 1 },
      }),
    ).toThrow();
    expect(() =>
      searchCsv(data, {
        query: "hit",
        position: { row: 1, column: 2, charOffset: 0 },
      }),
    ).toThrow();
    expect(
      searchCsv(data, {
        query: "hit",
        position: { row: 2, column: 0, charOffset: 0 },
      }),
    ).toEqual({ matches: [], nextPosition: null });
  });
});
