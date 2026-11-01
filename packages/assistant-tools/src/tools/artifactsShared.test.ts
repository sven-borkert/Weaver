import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boundItems, ToolError } from "../contract";
import {
  artifactEnvelope,
  assertSameContent,
  assembleChapterBlocks,
  assemblePdfPages,
  assembleRowPage,
  boundHeadCells,
  budgetAfter,
  cellText,
  headText,
  overviewText,
  nextSheetPosition,
  nextWorkbookPosition,
  parseWorkbookPosition,
  positionIndex,
  readerResult,
  wrongFormat,
} from "./artifactsShared";

const FILE = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  filename: "Q3 plan & notes.docx",
  contentType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  byteSize: 1234,
  sha256: "a".repeat(64),
  updatedAt: "2026-09-20T10:00:00.000Z",
};

describe("assertSameContent", () => {
  it("accepts a read of the very content the caller described", () => {
    expect(() => assertSameContent(FILE.sha256, FILE)).not.toThrow();
  });

  it("fails STALE_BASE when the file was replaced between the two lookups", () => {
    // describeArtifact and readArtifact each look the artifact up, so a
    // replace in between would apply the old position to new content.
    expect(() => assertSameContent("b".repeat(64), FILE)).toThrow(
      expect.objectContaining({
        code: "BAD_REQUEST",
        message:
          "the file was replaced; start again from get_artifact_overview",
        details: { reason: "STALE_BASE" },
      }),
    );
  });
});

describe("artifactEnvelope", () => {
  it("links to the project's Files page with the filename escaped", () => {
    expect(artifactEnvelope(FILE)).toEqual({
      id: FILE.id,
      filename: FILE.filename,
      contentType: FILE.contentType,
      byteSize: 1234,
      sha256: FILE.sha256,
      updatedAt: FILE.updatedAt,
      url: `/projects/${FILE.projectId}/artifacts?file=Q3%20plan%20%26%20notes.docx`,
    });
  });
});

describe("wrongFormat", () => {
  it("names the formats the calling tool reads and the tool for this file", () => {
    expect(wrongFormat("excel", "search_artifact_text").message).toBe(
      "search_artifact_text reads Word, PDF, text, Markdown, CSV, YAML and OneNote files; for an Excel file use read_excel_sheet",
    );
    expect(wrongFormat("word", "query_json_artifact").message).toBe(
      "query_json_artifact reads JSON and YAML files; for a Word file use read_word_chapter",
    );
    expect(wrongFormat("json", "read_pdf_pages").message).toBe(
      "read_pdf_pages reads PDF files; for a JSON file use query_json_artifact",
    );
  });

  it("reports a file type no reader handles", () => {
    const error = wrongFormat(null, "read_pdf_pages");
    expect(error).toBeInstanceOf(ToolError);
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toBe(
      "read_pdf_pages reads PDF files; this file type has no reader",
    );
  });

  it("stays inside the model-facing message budget", () => {
    for (const tool of [
      "search_artifact_text",
      "query_json_artifact",
      "read_pdf_pages",
      "read_word_chapter",
      "find_word_tables",
      "read_word_table",
      "read_excel_sheet",
    ])
      for (const actual of ["word", "excel", "pdf", "json", null] as const)
        expect(wrongFormat(actual, tool).message.length).toBeLessThanOrEqual(
          300,
        );
  });
});

describe("readerResult", () => {
  it("narrows a value that crossed the child boundary", () => {
    expect(readerResult(z.object({ total: z.number() }), { total: 3 })).toEqual(
      {
        total: 3,
      },
    );
  });

  it("treats a shape the readers should never produce as an internal failure", () => {
    expect(() => readerResult(z.object({ total: z.number() }), {})).toThrow(
      expect.objectContaining({ code: "INTERNAL" }),
    );
  });
});

describe("assemblePdfPages", () => {
  const WINDOW = 1_000;
  const limits = (
    over: Partial<Parameters<typeof assemblePdfPages>[2]> = {},
  ) => ({
    lastPage: 10,
    budgetChars: 5_000,
    windowChars: WINDOW,
    ...over,
  });

  it("returns a whole range and stops when the reader was not cut", () => {
    const assembled = assemblePdfPages(
      {
        pages: [
          { page: 1, text: "one" },
          { page: 2, text: "two" },
        ],
        truncated: false,
      },
      { page: 1, charOffset: 0 },
      limits({ lastPage: 2 }),
    );
    expect(assembled.pages).toEqual([
      { page: 1, text: "one" },
      { page: 2, text: "two" },
    ]);
    expect(assembled.nextPosition).toBeNull();
    expect(assembled.omittedPageTail).toBeNull();
  });

  it("resumes at the reader's own cut inside a page", () => {
    const assembled = assemblePdfPages(
      {
        pages: [
          { page: 1, text: "one" },
          { page: 2, text: "partial" },
        ],
        truncated: true,
      },
      { page: 1, charOffset: 0 },
      limits(),
    );
    expect(assembled.pages.at(-1)).toEqual({ page: 2, text: "partial" });
    expect(assembled.nextPosition).toBe("2:7");
    expect(assembled.omittedPageTail).toBeNull();
  });

  it("restarts the reader window on a page the reader returned empty", () => {
    // The window ended exactly on a page boundary: page 3 arrives as an empty
    // prefix, and skipping it would drop the whole page.
    const assembled = assemblePdfPages(
      {
        pages: [
          { page: 1, text: "one" },
          { page: 2, text: "two" },
          { page: 3, text: "" },
        ],
        truncated: true,
      },
      { page: 1, charOffset: 0 },
      limits(),
    );
    expect(assembled.pages.map((page) => page.page)).toEqual([1, 2]);
    expect(assembled.nextPosition).toBe("3:0");
    expect(assembled.omittedPageTail).toBeNull();
  });

  it("skips the unreachable tail of a page longer than one window", () => {
    const assembled = assemblePdfPages(
      { pages: [{ page: 4, text: "x".repeat(WINDOW) }], truncated: true },
      { page: 4, charOffset: WINDOW },
      limits(),
    );
    expect(assembled.pages).toEqual([]);
    expect(assembled.nextPosition).toBe("5:0");
    expect(assembled.omittedPageTail).toBe(4);
  });

  it("ends the read when that unreachable page is the last one in range", () => {
    const assembled = assemblePdfPages(
      { pages: [{ page: 10, text: "x".repeat(WINDOW) }], truncated: true },
      { page: 10, charOffset: WINDOW },
      limits(),
    );
    expect(assembled.nextPosition).toBeNull();
    expect(assembled.omittedPageTail).toBe(10);
  });

  it("cuts inside a page when the output budget runs out", () => {
    const assembled = assemblePdfPages(
      { pages: [{ page: 1, text: "y".repeat(900) }], truncated: false },
      { page: 1, charOffset: 0 },
      limits({ budgetChars: 300 }),
    );
    expect(assembled.pages[0]!.text.length).toBeGreaterThan(0);
    expect(assembled.pages[0]!.text.length).toBeLessThan(900);
    expect(assembled.nextPosition).toBe(`1:${assembled.pages[0]!.text.length}`);
  });

  it("continues from a cursor offset inside the first page only", () => {
    const assembled = assemblePdfPages(
      {
        pages: [
          { page: 2, text: "abcdef" },
          { page: 3, text: "ghi" },
        ],
        truncated: false,
      },
      { page: 2, charOffset: 3 },
      limits(),
    );
    expect(assembled.pages).toEqual([
      { page: 2, text: "def" },
      { page: 3, text: "ghi" },
    ]);
  });

  it("never splits a surrogate pair at the chunk edge", () => {
    const assembled = assemblePdfPages(
      { pages: [{ page: 1, text: "😀".repeat(50) }], truncated: false },
      { page: 1, charOffset: 0 },
      limits({ budgetChars: 60 }),
    );
    const text = assembled.pages[0]!.text;
    expect(text.length % 2).toBe(0);
    expect([...text].length).toBe(text.length / 2);
    expect(assembled.nextPosition).toBe(`1:${text.length}`);
  });

  it("advances past a position that would repeat itself", () => {
    // A reader result that offers nothing new at the incoming position must
    // still move the cursor on, or the caller loops forever.
    const assembled = assemblePdfPages(
      { pages: [{ page: 2, text: "short" }], truncated: true },
      { page: 2, charOffset: 5 },
      limits(),
    );
    expect(assembled.pages).toEqual([]);
    expect(assembled.nextPosition).toBe("3:0");
    expect(assembled.omittedPageTail).toBe(2);
  });
});

describe("assembleChapterBlocks", () => {
  const paragraph = (ordinal: number, text: string) => ({
    blockId: `p-${String(ordinal).padStart(3, "0")}`,
    type: "paragraph" as const,
    kind: "content",
    text,
  });
  const table = (ordinal: number, values?: string[][]) => ({
    blockId: `table-${String(ordinal).padStart(3, "0")}`,
    type: "table" as const,
    tableId: `table-${String(ordinal).padStart(3, "0")}`,
    rowCount: values?.length ?? 40,
    columnCount: values?.[0]?.length ?? 6,
    ...(values ? { values } : {}),
  });

  it("returns a whole chapter and ends the read", () => {
    const page = assembleChapterBlocks(
      [paragraph(1, "one"), paragraph(2, "two")],
      0,
      { budgetChars: 5_000 },
    );
    expect(page.blocks.map((block) => block.blockId)).toEqual([
      "p-001",
      "p-002",
    ]);
    expect(page.nextIndex).toBeNull();
    expect(page.clamped).toBe(false);
  });

  it("reports an empty chapter as a finished read", () => {
    expect(assembleChapterBlocks([], 0, { budgetChars: 5_000 })).toEqual({
      blocks: [],
      nextIndex: null,
      clamped: false,
    });
  });

  it("continues from the cursor's block index", () => {
    const page = assembleChapterBlocks(
      [paragraph(1, "one"), paragraph(2, "two"), paragraph(3, "three")],
      2,
      { budgetChars: 5_000 },
    );
    expect(page.blocks.map((block) => block.blockId)).toEqual(["p-003"]);
    expect(page.nextIndex).toBeNull();
  });

  it("stops at the first block that does not fit and resumes there", () => {
    const blocks = [
      paragraph(1, "a".repeat(200)),
      paragraph(2, "b".repeat(200)),
    ];
    const page = assembleChapterBlocks(blocks, 0, { budgetChars: 280 });
    expect(page.blocks.map((block) => block.blockId)).toEqual(["p-001"]);
    expect(page.nextIndex).toBe(1);
    // The next page gets a full budget, so the block is not clamped here.
    expect(page.clamped).toBe(false);
    expect(page.blocks[0]!.type === "paragraph" && page.blocks[0]!.text).toBe(
      "a".repeat(200),
    );
  });

  it("fills a page exactly and still reports the next block", () => {
    const one = paragraph(1, "a".repeat(50));
    const exact = JSON.stringify(one).length + 1;
    const page = assembleChapterBlocks([one, paragraph(2, "b")], 0, {
      budgetChars: exact,
    });
    expect(page.blocks).toHaveLength(1);
    expect(page.nextIndex).toBe(1);
  });

  it("clamps a paragraph larger than the whole budget and advances past it", () => {
    const page = assembleChapterBlocks([paragraph(1, "x".repeat(5_000))], 0, {
      budgetChars: 400,
    });
    expect(page.blocks).toHaveLength(1);
    const block = page.blocks[0]!;
    if (block.type !== "paragraph") throw new Error("expected a paragraph");
    expect(block.text.length).toBeGreaterThan(0);
    expect(block.text.length).toBeLessThan(5_000);
    expect(block.clamped).toBe(true);
    expect(page.clamped).toBe(true);
    expect(page.nextIndex).toBeNull();
  });

  it("keeps a paragraph's id alone when not even an empty one would fit", () => {
    const page = assembleChapterBlocks(
      [
        {
          ...paragraph(1, "x".repeat(500)),
          headingLevel: 2,
          chapterId: "chapter-007",
        },
      ],
      0,
      { budgetChars: 40 },
    );
    expect(page.blocks).toEqual([
      {
        blockId: "p-001",
        type: "paragraph",
        kind: "content",
        text: "",
        clamped: true,
        omitted: true,
      },
    ]);
    expect(page.nextIndex).toBeNull();
    expect(page.clamped).toBe(true);
  });

  const picture = (label: string) => ({
    markdown: `![${label}](weaver-image:${FILE.id}/${"a".repeat(64)})`,
    contentType: "image/png",
    byteSize: 100,
  });
  const size = (entry: unknown) => JSON.stringify(entry).length + 1;

  it("says how many pictures a clamped paragraph had", () => {
    const page = assembleChapterBlocks(
      [
        {
          ...paragraph(1, "x".repeat(5_000)),
          images: [picture("one"), picture("two"), picture("three")],
          imageWarnings: ["image is too large"],
        },
      ],
      0,
      { budgetChars: 400 },
    );
    const block = page.blocks[0]!;
    expect(block).toMatchObject({ clamped: true, imageCount: 3 });
    expect(block).not.toHaveProperty("images");
    expect(block).not.toHaveProperty("imageWarnings");
    expect(size(block)).toBeLessThanOrEqual(400);

    const plain = assembleChapterBlocks([paragraph(1, "x".repeat(5_000))], 0, {
      budgetChars: 400,
    });
    expect(plain.blocks[0]).not.toHaveProperty("imageCount");
  });

  it("keeps the picture count on an id-only paragraph only when it fits", () => {
    const heading = {
      ...paragraph(1, "x".repeat(500)),
      headingLevel: 2,
      chapterId: "chapter-007",
      images: [picture("one"), picture("two")],
    };
    const idOnly = {
      blockId: "p-001",
      type: "paragraph",
      kind: "content",
      text: "",
      clamped: true,
      omitted: true,
    };
    const counted = { ...idOnly, imageCount: 2 };
    expect(
      assembleChapterBlocks([heading], 0, { budgetChars: size(counted) })
        .blocks,
    ).toEqual([counted]);
    expect(
      assembleChapterBlocks([heading], 0, { budgetChars: size(counted) - 1 })
        .blocks,
    ).toEqual([idOnly]);
  });

  it("replaces a table that cannot fit with a summary naming read_word_table", () => {
    const page = assembleChapterBlocks(
      [
        table(
          1,
          Array.from({ length: 200 }, () => ["cell value", "another"]),
        ),
      ],
      0,
      { budgetChars: 300 },
    );
    expect(page.blocks).toHaveLength(1);
    const block = page.blocks[0]!;
    expect(block).toMatchObject({
      type: "table",
      tableId: "table-001",
      rowCount: 200,
      columnCount: 2,
      omitted: true,
    });
    expect(block).not.toHaveProperty("values");
    expect(block.hint).toContain("read_word_table");
    expect(page.nextIndex).toBeNull();
    expect(page.clamped).toBe(true);
  });

  it("keeps a table that fits after an earlier block for the next page", () => {
    const blocks = [paragraph(1, "a".repeat(200)), table(2, [["x", "y"]])];
    const page = assembleChapterBlocks(blocks, 0, { budgetChars: 300 });
    expect(page.blocks).toHaveLength(1);
    expect(page.nextIndex).toBe(1);
  });
});

describe("assembleRowPage", () => {
  const row = (number: number, values: Array<string | null>) => ({
    row: number,
    values,
  });

  it("keeps every row that fits and counts them", () => {
    const page = assembleRowPage([row(1, ["a", "b"]), row(2, ["c", null])], {
      budgetChars: 500,
    });
    expect(page.kept).toBe(2);
    expect(page.rows).toEqual([row(1, ["a", "b"]), row(2, ["c", null])]);
    expect(page.clamped).toBe(false);
  });

  it("reports an empty reader page", () => {
    expect(assembleRowPage([], { budgetChars: 500 })).toEqual({
      rows: [],
      kept: 0,
      clamped: false,
    });
  });

  it("fills a page exactly and keeps every row", () => {
    const rows = [row(1, ["a"]), row(2, ["b"])];
    const exact = rows.reduce(
      (total, item) => total + JSON.stringify(item).length + 1,
      0,
    );
    const page = assembleRowPage(rows, { budgetChars: exact });
    expect(page.kept).toBe(2);
    expect(page.clamped).toBe(false);
    const short = assembleRowPage(rows, { budgetChars: exact - 1 });
    expect(short.kept).toBe(1);
  });

  it("stops at the first row that does not fit", () => {
    const rows = [row(1, ["a".repeat(100)]), row(2, ["b".repeat(100)])];
    const page = assembleRowPage(rows, { budgetChars: 140 });
    expect(page.kept).toBe(1);
    expect(page.rows[0]!.values).toEqual(["a".repeat(100)]);
    expect(page.clamped).toBe(false);
  });

  it("carries the sheet name of a workbook read through", () => {
    const page = assembleRowPage(
      [{ sheet: "People", row: 3, values: ["Ada"] }],
      {
        budgetChars: 500,
      },
    );
    expect(page.rows[0]).toEqual({ sheet: "People", row: 3, values: ["Ada"] });
  });

  it("clamps the cells of a row larger than the whole budget and still advances", () => {
    const page = assembleRowPage(
      [row(7, ["x".repeat(4_000), "y".repeat(4_000)]), row(8, ["z"])],
      { budgetChars: 200 },
    );
    expect(page.kept).toBe(1);
    expect(page.rows[0]!.row).toBe(7);
    expect(page.rows[0]!.clamped).toBe(true);
    expect(page.rows[0]!.values[0]!.length).toBeGreaterThan(0);
    expect(page.rows[0]!.values[0]!.length).toBeLessThan(4_000);
    expect(JSON.stringify(page.rows[0]).length).toBeLessThanOrEqual(200);
    expect(page.clamped).toBe(true);
  });

  it("drops the values of a row whose empty cells alone overflow the budget", () => {
    const page = assembleRowPage(
      [
        row(
          1,
          Array.from({ length: 200 }, () => "value"),
        ),
      ],
      { budgetChars: 40 },
    );
    expect(page.kept).toBe(1);
    expect(page.rows[0]).toMatchObject({ row: 1, values: [], omitted: true });
  });
});

describe("excel cursor positions", () => {
  it("resumes a sheet read after the last kept row when the budget cut", () => {
    expect(
      nextSheetPosition([{ row: 10 }, { row: 11 }, { row: 12 }], 2, "13"),
    ).toBe("12");
  });

  it("uses the reader's own cursor when the whole reader page was kept", () => {
    expect(nextSheetPosition([{ row: 10 }, { row: 11 }], 2, "12")).toBe("12");
    expect(nextSheetPosition([{ row: 10 }], 1, null)).toBeNull();
    expect(nextSheetPosition([], 0, null)).toBeNull();
  });

  it("reads a workbook position, defaulting to the first row of the first sheet", () => {
    expect(parseWorkbookPosition(undefined)).toEqual({
      cursor: "1:1",
      skip: 0,
    });
    expect(parseWorkbookPosition("3:12")).toEqual({ cursor: "3:12", skip: 0 });
    expect(parseWorkbookPosition("3:12_40")).toEqual({
      cursor: "3:12",
      skip: 40,
    });
    for (const bad of ["", "3", "0:1", "3:0", "3:12_", "3:12_x", "x:y"])
      expect(() => parseWorkbookPosition(bad)).toThrow(
        expect.objectContaining({ details: { reason: "INVALID_CURSOR" } }),
      );
  });

  it("replays the reader page with a larger skip when the budget cut inside it", () => {
    expect(nextWorkbookPosition({ cursor: "1:1", skip: 0 }, 30, 80, null)).toBe(
      "1:1_30",
    );
    expect(
      nextWorkbookPosition({ cursor: "2:5", skip: 30 }, 12, 50, "3:1"),
    ).toBe("2:5_42");
  });

  it("hands over to the reader's cursor when the whole page was kept", () => {
    expect(
      nextWorkbookPosition({ cursor: "1:1", skip: 0 }, 80, 80, "2:1"),
    ).toBe("2:1");
    expect(
      nextWorkbookPosition({ cursor: "1:1", skip: 0 }, 80, 80, null),
    ).toBeNull();
    expect(
      nextWorkbookPosition({ cursor: "4:9", skip: 3 }, 0, 0, null),
    ).toBeNull();
  });

  it("reads a numeric position and rejects anything else", () => {
    expect(positionIndex("42")).toBe(42);
    for (const bad of ["", "-1", "1.5", "x", "1:2"])
      expect(() => positionIndex(bad)).toThrow(
        expect.objectContaining({ details: { reason: "INVALID_CURSOR" } }),
      );
  });
});

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe("byte-charged assembly", () => {
  it("cuts a CJK PDF page to the byte budget", () => {
    const assembled = assemblePdfPages(
      { pages: [{ page: 1, text: "漢".repeat(900) }], truncated: false },
      { page: 1, charOffset: 0 },
      { lastPage: 1, budgetChars: 300, windowChars: 1_000 },
    );
    expect(bytes(assembled.pages)).toBeLessThanOrEqual(300);
    expect(assembled.pages[0]!.text.length).toBeGreaterThan(0);
    expect(assembled.nextPosition).toBe(`1:${assembled.pages[0]!.text.length}`);
  });

  it("clamps a CJK paragraph to the byte budget", () => {
    const page = assembleChapterBlocks(
      [
        {
          blockId: "p-001",
          type: "paragraph",
          kind: "content",
          text: "漢".repeat(5_000),
        },
      ],
      0,
      { budgetChars: 400 },
    );
    expect(page.clamped).toBe(true);
    expect(bytes(page.blocks)).toBeLessThanOrEqual(400);
  });

  it("keeps CJK rows within the byte budget", () => {
    const rows = Array.from({ length: 20 }, (_value, index) => ({
      row: index + 1,
      values: ["漢".repeat(50), "字".repeat(50)],
    }));
    const page = assembleRowPage(rows, { budgetChars: 1_000 });
    expect(page.kept).toBeGreaterThan(0);
    expect(page.kept).toBeLessThan(6);
    expect(bytes(page.rows)).toBeLessThanOrEqual(1_000 + page.kept);
  });
});

describe("head fields no file may grow", () => {
  it("clamps a head string to 500 bytes", () => {
    expect(headText("t".repeat(20_000))).toHaveLength(500);
    expect(headText("Findings")).toBe("Findings");
    const cjk = headText("漢".repeat(1_000));
    expect(Buffer.byteLength(cjk)).toBeLessThanOrEqual(500);
    expect(cjk).toHaveLength(166);
  });

  it("clamps a cell to bytes and never splits a pair", () => {
    expect(cellText("漢".repeat(1_000))).toHaveLength(40);
    expect(cellText("😀".repeat(100), 10)).toBe("😀😀");
    expect(cellText({ text: "漢".repeat(1_000) }, 30)).toHaveLength(10);
  });

  it("bounds CJK header cells by their bytes", () => {
    const bounded = boundHeadCells(
      Array.from({ length: 63 }, () => "漢".repeat(100)),
      3,
    );
    expect(bounded.truncated).toBe(true);
    expect(bytes(bounded.cells)).toBeLessThanOrEqual(
      Math.floor((16_000 - 1_500) / 3) + bounded.cells.length,
    );
  });

  it("clamps every header cell and drops what its share of the page cannot hold", () => {
    const bounded = boundHeadCells(
      Array.from({ length: 63 }, () => "h".repeat(300)),
      3,
    );
    expect(bounded.truncated).toBe(true);
    expect(bounded.cells.length).toBeLessThan(63);
    expect(bounded.cells[0]).toHaveLength(120);
    expect(JSON.stringify(bounded.cells).length).toBeLessThanOrEqual(
      Math.floor(14_500 / 3),
    );
  });

  it("keeps a short header row whole", () => {
    expect(boundHeadCells(["Name", "Role"], 3)).toEqual({
      cells: ["Name", "Role"],
      truncated: false,
    });
  });
});

describe("overviewText", () => {
  it("clamps a file-derived list string to 200 bytes and says so", () => {
    expect(overviewText("Chapter 1")).toEqual({
      text: "Chapter 1",
      truncated: false,
    });
    const long = overviewText("t".repeat(20_000));
    expect(long.text).toHaveLength(200);
    expect(long.truncated).toBe(true);
    const cjk = overviewText("漢".repeat(20_000));
    expect(Buffer.byteLength(cjk.text)).toBeLessThanOrEqual(200);
    expect(cjk.truncated).toBe(true);
  });

  it("keeps the entries after a 20,000-character title instead of dropping the list", () => {
    const chapters = [
      { chapterId: "chapter-001", level: 1, title: "t".repeat(20_000) },
      ...Array.from({ length: 50 }, (_value, index) => ({
        chapterId: `chapter-${String(index + 2).padStart(3, "0")}`,
        level: 1,
        title: `Chapter ${index + 2}`,
      })),
    ];
    const head = { readable: true, format: "word", hint: "h" };
    const raw = boundItems(chapters, budgetAfter({ result: head }));
    expect(raw.items.length).toBeLessThan(chapters.length);
    const clamped = boundItems(
      chapters.map((chapter) => {
        const title = overviewText(chapter.title);
        return {
          ...chapter,
          title: title.text,
          ...(title.truncated ? { titleTruncated: true as const } : {}),
        };
      }),
      budgetAfter({ result: head }),
    );
    expect(clamped.truncated).toBe(false);
    expect(clamped.items).toHaveLength(chapters.length);
    expect(clamped.items[0]).toMatchObject({ titleTruncated: true });
    expect(clamped.items[0]!.title).toHaveLength(200);
    expect(clamped.items.at(-1)!.title).toBe("Chapter 51");
  });
});
