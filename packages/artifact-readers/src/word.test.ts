import { createHash } from "node:crypto";
import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it, vi } from "vitest";
import { ArtifactReadError } from "./errors";
import {
  buildDocx,
  documentXml,
  PNG_SIGNATURE,
  renderBlocks,
  type DocxBlockSpec,
} from "./testing/docxFixture";
import {
  findWordTables,
  readWordBlocks,
  readWordChapter,
  readWordDropdowns,
  readWordInstructions,
  readWordOutline,
  readWordTable,
  readWordTableInventory,
  searchWordText,
} from "./word";
import { loadStyleSheet } from "./word/controls";
import { createImageResolver } from "./word/images";
import { loadDocx, WORD_PART_MAX_BYTES } from "./word/package";
import { buildStructure } from "./word/structure";

const CENTRAL_SIGNATURE = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

function readCode(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (e: unknown) => {
      expect(e).toBeInstanceOf(ArtifactReadError);
      return (e as ArtifactReadError).code;
    },
  );
}

async function readMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    expect.unreachable();
  } catch (e) {
    return (e as ArtifactReadError).message;
  }
  throw new Error("unreachable");
}

/** The template shape the source fixtures exercise: front matter, a TOC
 *  control, guidance paragraphs, a caption + table with a dropdown, an
 *  SDT-wrapped table and a blank trailing heading. */
const TEMPLATE_BODY: DocxBlockSpec[] = [
  { type: "paragraph", text: "Document Title Page" },
  {
    type: "paragraph",
    style: "guidance",
    text: "This template is the MS Word template for the project document.",
  },
  { type: "toc", paragraphs: ["Contents line 1", "Contents line 2"] },
  { type: "heading", level: 1, text: "Background\tand need" },
  {
    type: "paragraph",
    style: "guidance",
    text: "Describe the background and business need.",
  },
  {
    type: "paragraph",
    runs: [
      { text: "Direct-formatted guidance. ", italic: true, color: "7C9DBE" },
      {
        text: "Real content that dominates this paragraph by character count.",
      },
    ],
  },
  {
    type: "paragraph",
    text: "Not required - will be sourced from master data.",
  },
  { type: "heading", level: 2, text: "Details" },
  { type: "paragraph", style: "Caption", text: "Table 1: Purpose Of System" },
  {
    type: "table",
    rows: [
      ["Question", "Please Complete"],
      [
        {
          paragraphs: [
            { text: "Fill this in per environment.", style: "guidance" },
          ],
        },
        {
          dropdown: {
            id: "77",
            type: "dropDownList",
            selectedText: "Choose an item.",
            placeholder: true,
            options: [{ value: "Yes" }],
          },
        },
      ],
    ],
  },
  {
    type: "contentControl",
    blocks: [
      {
        type: "table",
        rows: [
          ["Wrapped", "Header"],
          ["a", "b"],
        ],
      },
    ],
  },
  { type: "heading", level: 3, text: "" },
];

describe("readWordOutline", () => {
  it("reads a heading-based outline and table structure", async () => {
    const docx = await buildDocx({
      body: [
        { type: "heading", level: 1, text: "System Overview" },
        { type: "paragraph", text: "Intro text" },
        {
          type: "table",
          rows: [
            ["Name", "Value"],
            ["Owner", "Platform"],
          ],
        },
        { type: "heading", level: 1, text: "Interfaces" },
        { type: "paragraph", text: "API details" },
      ],
    });

    const outline = await readWordOutline(docx);

    expect(outline.chapters).toEqual([
      expect.objectContaining({
        chapterId: "chapter-001",
        level: 1,
        title: "System Overview",
      }),
      expect.objectContaining({
        chapterId: "chapter-002",
        level: 1,
        title: "Interfaces",
      }),
    ]);
    expect(outline.tables).toEqual([
      expect.objectContaining({
        tableId: "table-001",
        chapterId: "chapter-001",
        rows: 2,
        columns: 2,
      }),
    ]);
  });

  it("reads DOCX document XML that starts with a UTF-8 BOM", async () => {
    const docx = await buildDocx({
      documentXml: `﻿${documentXml(
        renderBlocks([{ type: "heading", level: 1, text: "BOM Heading" }]),
      )}`,
    });

    await expect(readWordOutline(docx)).resolves.toMatchObject({
      chapters: [
        expect.objectContaining({
          chapterId: "chapter-001",
          title: "BOM Heading",
        }),
      ],
    });
  });

  it("surfaces a single synthetic body chapter for a headerless document", async () => {
    const docx = await buildDocx({ body: [] });

    const outline = await readWordOutline(docx);

    expect(outline.tables).toEqual([]);
    expect(outline.chapters).toHaveLength(1);
    expect(outline.chapters[0]).toMatchObject({
      chapterId: "document-body",
      level: 0,
      title: "Document body",
      blockId: null,
    });
  });

  it("exposes the front matter as chapter-000 with instruction counts and hygiene flags", async () => {
    const docx = await buildDocx({ body: TEMPLATE_BODY });

    const outline = await readWordOutline(docx);

    expect(outline.chapters[0]).toMatchObject({
      chapterId: "chapter-000",
      title: "Front matter",
      level: 0,
      instructionParagraphCount: 1,
    });
    // Heading chapters keep their 1-based ids; tab in the title is normalized.
    expect(outline.chapters[1]).toMatchObject({
      chapterId: "chapter-001",
      title: "Background and need",
    });
    // The blank Heading 3 is flagged as empty outline noise.
    expect(outline.chapters.find((chapter) => chapter.empty)).toMatchObject({
      title: "",
    });

    const front = await readWordChapter(docx, { chapterId: "chapter-000" });
    expect(
      front.blocks.map((block) =>
        block.type === "paragraph" ? block.kind : "table",
      ),
    ).toEqual(["content", "instruction", "toc"]);
    expect(
      front.blocks.find(
        (block) => block.type === "paragraph" && block.kind === "toc",
      ),
    ).toMatchObject({ text: "[Table of contents]" });
  });

  it("produces the same ids for two reads of the same bytes", async () => {
    const docx = await buildDocx({ body: TEMPLATE_BODY });

    const first = await readWordOutline(docx);
    const second = await readWordOutline(docx);

    expect(second.chapters.map((chapter) => chapter.chapterId)).toEqual(
      first.chapters.map((chapter) => chapter.chapterId),
    );
    expect(second.tables.map((table) => table.tableId)).toEqual(
      first.tables.map((table) => table.tableId),
    );
  });
});

describe("readWordChapter", () => {
  it("reads chapter content and table cells", async () => {
    const docx = await buildDocx({
      body: [
        { type: "heading", level: 1, text: "System Overview" },
        { type: "paragraph", text: "Intro text" },
        {
          type: "table",
          rows: [
            ["Name", "Value"],
            ["Owner", "Platform"],
          ],
        },
      ],
    });

    await expect(
      readWordChapter(docx, { chapterId: "chapter-001", includeTables: true }),
    ).resolves.toMatchObject({
      chapterId: "chapter-001",
      title: "System Overview",
      blocks: [
        { blockId: "p-002", type: "paragraph", text: "Intro text" },
        { blockId: "table-001", type: "table" },
      ],
    });
    await expect(
      readWordTable(docx, { tableId: "table-001" }),
    ).resolves.toEqual({
      tableId: "table-001",
      chapterId: "chapter-001",
      header: ["Name", "Value"],
      rowCount: 2,
      columnCount: 2,
      rows: [
        ["Name", "Value"],
        ["Owner", "Platform"],
      ],
      nextRow: null,
    });
  });

  it("windows blocks after the instruction filter and reports the continuation", async () => {
    const docx = await buildDocx({
      body: [
        { type: "heading", level: 1, text: "Windowed" },
        { type: "paragraph", style: "guidance", text: "Guidance first." },
        ...Array.from({ length: 5 }, (_value, index) => ({
          type: "paragraph" as const,
          text: `Content ${index + 1}`,
        })),
        {
          type: "table",
          rows: [["only cell"]],
        },
      ],
    });

    const whole = await readWordChapter(docx, { chapterId: "chapter-001" });
    expect(whole.blockCount).toBe(7);
    expect(whole.nextBlock).toBeNull();
    expect(whole.blocks).toHaveLength(7);

    const first = await readWordChapter(docx, {
      chapterId: "chapter-001",
      excludeInstructions: true,
      maxBlocks: 2,
    });
    expect(first).toMatchObject({ blockCount: 6, nextBlock: 2 });
    expect(first.blocks.map((block) => block.blockId)).toEqual([
      "p-003",
      "p-004",
    ]);

    const second = await readWordChapter(docx, {
      chapterId: "chapter-001",
      excludeInstructions: true,
      fromBlock: first.nextBlock!,
      maxBlocks: 2,
    });
    expect(second).toMatchObject({ blockCount: 6, nextBlock: 4 });
    expect(second.blocks.map((block) => block.blockId)).toEqual([
      "p-005",
      "p-006",
    ]);

    const last = await readWordChapter(docx, {
      chapterId: "chapter-001",
      excludeInstructions: true,
      fromBlock: 4,
      maxBlocks: 2,
    });
    expect(last.nextBlock).toBeNull();
    expect(last.blocks.map((block) => block.blockId)).toEqual([
      "p-007",
      "table-001",
    ]);

    const beyond = await readWordChapter(docx, {
      chapterId: "chapter-001",
      fromBlock: 50,
    });
    expect(beyond).toMatchObject({
      blocks: [],
      blockCount: 7,
      nextBlock: null,
    });
  });

  it("rejects a malformed block window with invalid_input", async () => {
    const docx = await buildDocx({ body: TEMPLATE_BODY });
    for (const input of [
      { fromBlock: -1 },
      { fromBlock: 1.5 },
      { maxBlocks: 0 },
      { maxBlocks: 501 },
    ]) {
      expect(
        await readCode(
          readWordChapter(docx, { chapterId: "chapter-001", ...input }),
        ),
      ).toBe("invalid_input");
    }
  });

  it("classifies paragraphs, marks nested headings, and reads the TOC collapsed", async () => {
    const docx = await buildDocx({ body: TEMPLATE_BODY });

    const chapter = await readWordChapter(docx, { chapterId: "chapter-001" });
    expect(
      chapter.blocks.map((block) =>
        block.type === "paragraph" ? block.kind : "table",
      ),
    ).toEqual([
      "instruction", // styled guidance
      "mixed", // direct-formatted guidance + dominant plain content
      "content",
      "heading", // nested Heading 2 is marked, not plain text
      "caption",
      "table",
      "table",
      "heading",
    ]);
    expect(
      chapter.blocks.find(
        (block) => block.type === "paragraph" && block.kind === "heading",
      ),
    ).toMatchObject({ headingLevel: 2, chapterId: "chapter-002" });

    const clean = await readWordChapter(docx, {
      chapterId: "chapter-001",
      excludeInstructions: true,
    });
    expect(
      clean.blocks.some(
        (block) => block.type === "paragraph" && block.kind === "instruction",
      ),
    ).toBe(false);
  });

  it("throws not_found for an unknown chapterId without naming real chapters", async () => {
    const docx = await buildDocx({ body: TEMPLATE_BODY });

    const code = await readCode(
      readWordChapter(docx, { chapterId: "chapter-900" }),
    );
    expect(code).toBe("not_found");
    const message = await readMessage(
      readWordChapter(docx, { chapterId: "chapter-900" }),
    );
    expect(message).toContain("chapter-900");
    expect(message).not.toContain("Background");
  });

  it("throws invalid_input for a malformed chapterId", async () => {
    const docx = await buildDocx({ body: TEMPLATE_BODY });

    expect(await readCode(readWordChapter(docx, { chapterId: "" }))).toBe(
      "invalid_input",
    );
    expect(
      await readCode(readWordChapter(docx, { chapterId: "table-001" })),
    ).toBe("invalid_input");
  });
});

describe("readWordTable", () => {
  it("reads dropdown and combo box content controls in table cells", async () => {
    const docx = await buildDocx({
      body: [
        { type: "heading", level: 1, text: "Infrastructure" },
        {
          type: "paragraph",
          text: "Table 16: Logical Infrastructure Nodes, Actors, Network Zones And Resource Groups",
        },
        {
          type: "table",
          rows: [
            ["Specified Node ID", "Network Zone", "Deployment Target"],
            [
              "SN001",
              {
                dropdown: {
                  id: "2036067473",
                  type: "dropDownList",
                  alias: "Network Zone",
                  tag: "network-zone",
                  selectedText: "DMZ Print",
                  options: [
                    { value: "LAN" },
                    { value: "DMZ", displayText: "DMZ Print" },
                  ],
                },
              },
              {
                dropdown: {
                  id: "2036067474",
                  type: "comboBox",
                  selectedText: "Choose an item.",
                  placeholder: true,
                  options: [{ value: "Azure" }, { value: "AWS" }],
                },
              },
            ],
            [
              {
                wrapDropdown: {
                  id: "2036067475",
                  type: "dropDownList",
                  selectedText: "LAN",
                  options: [{ value: "LAN" }, { value: "External/Internet" }],
                },
              },
            ],
          ],
        },
      ],
    });

    const outline = await readWordOutline(docx);
    expect(outline.tables[0]).toMatchObject({
      tableId: "table-001",
      chapterId: "chapter-001",
      caption:
        "Table 16: Logical Infrastructure Nodes, Actors, Network Zones And Resource Groups",
      rows: 3,
      columns: 3,
      contentControlCount: 3,
      dropdownCount: 3,
    });

    await expect(
      readWordTable(docx, { tableId: "table-001", includeDropdowns: true }),
    ).resolves.toMatchObject({
      tableId: "table-001",
      rows: [
        ["Specified Node ID", "Network Zone", "Deployment Target"],
        // The unfilled dropdown's placeholder is not reported as a value; it
        // surfaces via placeholderCells instead.
        ["SN001", "DMZ Print", ""],
        ["LAN"],
      ],
      placeholderCells: [
        { rowIndex: 2, columnIndex: 3, placeholder: "Choose an item." },
      ],
      dropdowns: [
        {
          controlId: "2036067473",
          controlType: "dropDownList",
          tableId: "table-001",
          rowIndex: 2,
          columnIndex: 2,
          chapterId: "chapter-001",
          alias: "Network Zone",
          tag: "network-zone",
          selectedText: "DMZ Print",
          selectedValue: "DMZ",
          placeholderShown: false,
          optionCount: 2,
          options: [
            { value: "LAN", displayText: "LAN" },
            { value: "DMZ", displayText: "DMZ Print" },
          ],
        },
        {
          controlId: "2036067474",
          controlType: "comboBox",
          selectedText: "Choose an item.",
          selectedValue: null,
          placeholderShown: true,
        },
        {
          controlId: "2036067475",
          tableId: "table-001",
          rowIndex: 3,
          columnIndex: 1,
          selectedValue: "LAN",
        },
      ],
    });
  });

  it("reads placeholder-only cells as empty values with placeholderCells metadata", async () => {
    const docx = await buildDocx({ body: TEMPLATE_BODY });

    const read = await readWordTable(docx, { tableId: "table-001" });

    expect(read.rows[1]![1]).toBe("");
    expect(read.placeholderCells).toEqual([
      { rowIndex: 2, columnIndex: 2, placeholder: "Choose an item." },
    ]);
  });

  it("windows rows while keeping the header and whole-table counts", async () => {
    const docx = await buildDocx({
      body: [
        { type: "heading", level: 1, text: "Rows" },
        {
          type: "table",
          rows: [
            ["A", "B", "C"],
            ...Array.from({ length: 5 }, (_value, index) => [
              `r${index + 1}`,
              "x",
            ]),
          ],
        },
      ],
    });

    const first = await readWordTable(docx, {
      tableId: "table-001",
      fromRow: 1,
      maxRows: 2,
    });
    expect(first).toEqual({
      tableId: "table-001",
      chapterId: "chapter-001",
      header: ["A", "B", "C"],
      rowCount: 6,
      columnCount: 3,
      rows: [
        ["r1", "x"],
        ["r2", "x"],
      ],
      nextRow: 3,
    });
    const last = await readWordTable(docx, {
      tableId: "table-001",
      fromRow: first.nextRow!,
      maxRows: 3,
    });
    expect(last.rows.map((row) => row[0])).toEqual(["r3", "r4", "r5"]);
    expect(last.nextRow).toBeNull();
    expect(
      await readWordTable(docx, { tableId: "table-001", fromRow: 10 }),
    ).toMatchObject({ header: ["A", "B", "C"], rows: [], nextRow: null });
    for (const input of [{ fromRow: -1 }, { maxRows: 501 }]) {
      expect(
        await readCode(readWordTable(docx, { tableId: "table-001", ...input })),
      ).toBe("invalid_input");
    }
  });

  it("sends dropdowns and window-local placeholder cells with the first page only", async () => {
    const docx = await buildDocx({ body: TEMPLATE_BODY });

    const first = await readWordTable(docx, {
      tableId: "table-001",
      includeDropdowns: true,
      fromRow: 1,
    });
    expect(first.dropdowns).toHaveLength(1);
    expect(first.placeholderCells).toEqual([
      { rowIndex: 2, columnIndex: 2, placeholder: "Choose an item." },
    ]);

    const later = await readWordTable(docx, {
      tableId: "table-001",
      includeDropdowns: true,
      fromRow: 2,
    });
    expect(later.dropdowns).toBeUndefined();
    expect(later.placeholderCells).toBeUndefined();
    expect(
      (
        await readWordTable(docx, {
          tableId: "table-001",
          fromRow: 0,
          maxRows: 1,
        })
      ).placeholderCells,
    ).toBeUndefined();
  });

  it("throws not_found for an unknown tableId and invalid_input for a malformed one", async () => {
    const docx = await buildDocx({ body: TEMPLATE_BODY });

    expect(await readCode(readWordTable(docx, { tableId: "table-900" }))).toBe(
      "not_found",
    );
    expect(await readCode(readWordTable(docx, { tableId: "nope" }))).toBe(
      "invalid_input",
    );
  });
});

describe("readWordDropdowns", () => {
  it("scopes controls to one table, honours includeOptions and reports truncation", async () => {
    const docx = await buildDocx({ body: TEMPLATE_BODY });

    const all = await readWordDropdowns(docx, {});
    expect(all.controls).toHaveLength(1);
    expect(all.truncated).toBe(false);
    expect(all.controls[0]).toMatchObject({
      controlId: "77",
      controlType: "dropDownList",
      tableId: "table-001",
      rowIndex: 2,
      columnIndex: 2,
      chapterId: "chapter-002",
      placeholderShown: true,
      selectedValue: null,
      optionCount: 1,
      options: [{ value: "Yes", displayText: "Yes" }],
    });

    const noOptions = await readWordDropdowns(docx, {
      tableId: "table-001",
      includeOptions: false,
      maxControls: 1,
    });
    expect(noOptions.controls).toHaveLength(1);
    expect(noOptions.truncated).toBe(false);
    expect(noOptions.controls[0]).not.toHaveProperty("options");

    const scoped = await readWordDropdowns(docx, { chapterId: "chapter-000" });
    expect(scoped.controls).toEqual([]);
  });

  it("truncates at maxControls", async () => {
    const docx = await buildDocx({
      body: [
        {
          type: "table",
          rows: [
            [
              {
                dropdown: {
                  id: "1",
                  type: "dropDownList",
                  selectedText: "A",
                  options: [{ value: "A" }],
                },
              },
              {
                dropdown: {
                  id: "2",
                  type: "comboBox",
                  selectedText: "B",
                  options: [{ value: "B" }],
                },
              },
            ],
          ],
        },
      ],
    });

    const read = await readWordDropdowns(docx, { maxControls: 1 });

    expect(read.controls).toHaveLength(1);
    expect(read.truncated).toBe(true);
  });

  it("rejects an out-of-range maxControls with invalid_input", async () => {
    const docx = await buildDocx({ body: TEMPLATE_BODY });

    expect(await readCode(readWordDropdowns(docx, { maxControls: 0 }))).toBe(
      "invalid_input",
    );
    expect(await readCode(readWordDropdowns(docx, { maxControls: 301 }))).toBe(
      "invalid_input",
    );
  });
});

describe("readWordInstructions", () => {
  it("groups guidance by chapter, includes table cells, and reads comments", async () => {
    const docx = await buildDocx({
      body: TEMPLATE_BODY,
      comments: [
        {
          id: "1",
          author: "Template Author",
          text: "Template instructions\nThis section explains the template.",
        },
      ],
    });

    const result = await readWordInstructions(docx, {});

    expect(result.totalItems).toBe(4);
    const frontGroup = result.groups.find(
      (group) => group.chapterId === "chapter-000",
    );
    expect(frontGroup?.items[0]?.text).toContain(
      "This template is the MS Word template",
    );
    const tableItem = result.groups
      .flatMap((group) => group.items)
      .find((item) => item.tableId);
    expect(tableItem).toMatchObject({
      tableId: "table-001",
      rowIndex: 2,
      columnIndex: 1,
      kind: "instruction",
      text: "Fill this in per environment.",
    });
    expect(result.comments).toEqual([
      {
        commentId: "1",
        author: "Template Author",
        date: null,
        text: "Template instructions\nThis section explains the template.",
      },
    ]);

    const scoped = await readWordInstructions(docx, {
      chapterId: "chapter-000",
    });
    expect(scoped.totalItems).toBe(1);
  });

  it("honours a custom instruction profile", async () => {
    const docx = await buildDocx({
      body: [
        { type: "heading", level: 1, text: "Chapter" },
        { type: "paragraph", style: "hinweis", text: "Bitte ausfüllen." },
      ],
    });

    await expect(
      readWordInstructions(docx, { styleNames: ["hinweis"] }),
    ).resolves.toMatchObject({ totalItems: 1 });
    await expect(readWordInstructions(docx, {})).resolves.toMatchObject({
      totalItems: 0,
    });
  });

  it("returns no comments when word/comments.xml is absent", async () => {
    const docx = await buildDocx({ body: TEMPLATE_BODY });

    await expect(readWordInstructions(docx, {})).resolves.toMatchObject({
      comments: [],
    });
  });

  it("falls back to style ids when word/styles.xml is absent", async () => {
    const docx = await buildDocx({ body: TEMPLATE_BODY, styles: false });

    // The style index is empty, so the chain resolves to the raw pStyle id:
    // "guidance" still matches the profile, "Caption" still reads as a caption.
    await expect(readWordInstructions(docx, {})).resolves.toMatchObject({
      totalItems: 4,
    });
    const chapter = await readWordChapter(docx, { chapterId: "chapter-001" });
    expect(
      chapter.blocks.map((block) =>
        block.type === "paragraph" ? block.kind : "table",
      ),
    ).toEqual([
      "instruction",
      "mixed",
      "content",
      "heading",
      "caption",
      "table",
      "table",
      "heading",
    ]);
  });
});

describe("readWordTableInventory", () => {
  it("inventories every table with nearest-heading attribution and population status", async () => {
    const docx = await buildDocx({ body: TEMPLATE_BODY });

    const inventory = await readWordTableInventory(docx);

    expect(inventory.truncated).toBe(false);
    expect(inventory.tables).toHaveLength(2);
    expect(inventory.tables[0]).toMatchObject({
      tableId: "table-001",
      caption: "Table 1: Purpose Of System",
      chapterId: "chapter-002", // the level-2 "Details", not level-1
      chapterPath: "1.1 Details",
      rows: 2,
      dataRows: 1,
      emptyDataRows: 0,
      dropdownCount: 1,
    });
    // The SDT-wrapped table is inventoried too; no entry carries cell text.
    expect(inventory.tables[1]).toMatchObject({ tableId: "table-002" });
    expect(inventory.tables[1]).not.toHaveProperty("headerRow");
  });

  it("caps the outline and the inventory at 5,000 entries and says so", async () => {
    const docx = await buildDocx({
      body: [
        ...Array.from({ length: 5_001 }, (_value, index) => ({
          type: "heading" as const,
          level: 1,
          text: `H${index + 1}`,
        })),
        ...Array.from({ length: 5_001 }, () => ({
          type: "table" as const,
          rows: [["c"]],
        })),
      ],
    });

    const outline = await readWordOutline(docx);
    expect(outline.truncated).toBe(true);
    expect(outline.chapters).toHaveLength(5_000);
    expect(outline.tables).toHaveLength(5_000);
    expect(outline.tables.at(-1)?.tableId).toBe("table-5000");

    const inventory = await readWordTableInventory(docx);
    expect(inventory.truncated).toBe(true);
    expect(inventory.tables).toHaveLength(5_000);
  }, 60_000);
});

describe("findWordTables", () => {
  it("finds tables by caption, chapter, and expected headers", async () => {
    const docx = await buildDocx({
      body: [
        { type: "heading", level: 1, text: "To be architecture" },
        { type: "paragraph", text: "Table 15: Application Connections" },
        {
          type: "table",
          rows: [
            ["Connection Number", "APP ID", "Element Name", "Description"],
            ["1", "APP-xxxx", "Application name", "Application description"],
          ],
        },
        {
          type: "paragraph",
          text: "Table 16: Logical Infrastructure Nodes, Actors, Network Zones And Resource Groups",
        },
        {
          type: "table",
          rows: [
            [
              "Specified Node ID",
              "Node Label",
              "Description",
              "Network Zone",
              "Deployment Target",
            ],
            ["SN001", "API", "Application API", "DMZ Application", "AWS"],
          ],
        },
      ],
    });

    const result = await findWordTables(docx, {
      query:
        "Table 16: Logical Infrastructure Nodes, Actors, Network Zones And Resource Groups",
      chapterTitle: "To be architecture",
      expectedHeaders: ["Specified Node ID", "Network Zone"],
      includePreview: true,
    });

    expect(result.truncated).toBe(false);
    expect(result.candidates[0]).toMatchObject({
      tableId: "table-002",
      caption:
        "Table 16: Logical Infrastructure Nodes, Actors, Network Zones And Resource Groups",
      previewRows: [
        [
          "Specified Node ID",
          "Node Label",
          "Description",
          "Network Zone",
          "Deployment Target",
        ],
        ["SN001", "API", "Application API", "DMZ Application", "AWS"],
      ],
    });
    expect(result.candidates[0]?.chapter).toMatchObject({
      title: "To be architecture",
    });
    expect(typeof result.candidates[0]?.score).toBe("number");
    expect(result.candidates[0]!.score).toBeGreaterThan(
      result.candidates[1]!.score,
    );
    expect(result.candidates[0]!.matchReasons.join("\n")).toContain(
      "expected headers",
    );
  });

  it("warns when the document has no tables", async () => {
    const docx = await buildDocx({
      body: [{ type: "paragraph", text: "No tables here" }],
    });

    await expect(findWordTables(docx, {})).resolves.toMatchObject({
      candidates: [],
      truncated: false,
      warnings: ["No tables were found in the DOCX main document body."],
    });
  });

  it("rejects an out-of-range maxResults with invalid_input", async () => {
    const docx = await buildDocx({ body: TEMPLATE_BODY });

    expect(await readCode(findWordTables(docx, { maxResults: 0 }))).toBe(
      "invalid_input",
    );
    expect(await readCode(findWordTables(docx, { maxResults: 26 }))).toBe(
      "invalid_input",
    );
  });
});

describe("searchWordText", () => {
  it("covers body, tables, front matter and headers with truncation", async () => {
    const docx = await buildDocx({
      body: TEMPLATE_BODY,
      headers: { "header1.xml": "Confidential header phrase" },
    });

    const body = await searchWordText(docx, {
      query: "background and business",
    });
    expect(body.total).toBe(1);
    expect(body.matches[0]).toMatchObject({
      location: "body",
      chapterId: "chapter-001",
      blockId: "p-005",
    });

    const cell = await searchWordText(docx, { query: "please complete" });
    expect(cell.matches[0]).toMatchObject({
      location: "table",
      tableId: "table-001",
      rowIndex: 1,
      columnIndex: 2,
    });

    const front = await searchWordText(docx, { query: "Document Title Page" });
    expect(front.matches[0]).toMatchObject({ chapterId: "chapter-000" });

    const header = await searchWordText(docx, { query: "confidential" });
    expect(header.matches[0]).toMatchObject({
      location: "header",
      part: "header1.xml",
    });

    const truncated = await searchWordText(docx, { query: "e", limit: 1 });
    expect(truncated.truncated).toBe(true);
    expect(truncated.matches).toHaveLength(1);
    expect(truncated.total).toBeGreaterThan(1);
  });

  it("searches footer parts too", async () => {
    const docx = await buildDocx({
      body: [{ type: "paragraph", text: "Body" }],
      footers: { "footer1.xml": "Printed page footnote" },
    });

    await expect(
      searchWordText(docx, { query: "footnote" }),
    ).resolves.toMatchObject({
      total: 1,
      matches: [{ location: "footer", part: "footer1.xml" }],
    });
  });

  it("counts every match in total while returning at most limit matches", async () => {
    const docx = await buildDocx({
      body: [
        { type: "paragraph", text: "alpha alpha alpha" },
        { type: "paragraph", text: "alpha" },
      ],
    });

    const limited = await searchWordText(docx, { query: "alpha", limit: 2 });
    expect(limited.total).toBe(4);
    expect(limited.matches).toHaveLength(2);
    expect(limited.truncated).toBe(true);

    const all = await searchWordText(docx, { query: "alpha", limit: 10 });
    expect(all.total).toBe(4);
    expect(all.matches).toHaveLength(4);
    expect(all.truncated).toBe(false);
  });

  it("matches case-sensitively when matchCase is set", async () => {
    const docx = await buildDocx({
      body: [{ type: "paragraph", text: "Alpha alpha" }],
    });

    await expect(
      searchWordText(docx, { query: "Alpha", matchCase: true }),
    ).resolves.toMatchObject({ total: 1 });
    await expect(
      searchWordText(docx, { query: "Alpha" }),
    ).resolves.toMatchObject({ total: 2 });
  });

  it("rejects an empty query and an out-of-range limit with invalid_input", async () => {
    const docx = await buildDocx({ body: TEMPLATE_BODY });

    expect(await readCode(searchWordText(docx, { query: "" }))).toBe(
      "invalid_input",
    );
    expect(await readCode(searchWordText(docx, { query: "a", limit: 0 }))).toBe(
      "invalid_input",
    );
    expect(
      await readCode(searchWordText(docx, { query: "a", limit: 101 })),
    ).toBe("invalid_input");
  });
});

describe("file-shape failures", () => {
  it("reads a .dotx template content type like a .docx", async () => {
    const docx = await buildDocx.withContentType("template", {
      body: [{ type: "heading", level: 1, text: "Template Heading" }],
    });

    await expect(readWordOutline(docx)).resolves.toMatchObject({
      chapters: [expect.objectContaining({ title: "Template Heading" })],
    });
  });

  it("throws legacy_format for a macro-enabled content type", async () => {
    const docx = await buildDocx.withContentType("macro", {
      body: [{ type: "heading", level: 1, text: "Macro Heading" }],
    });

    expect(await readCode(readWordOutline(docx))).toBe("legacy_format");
  });

  it("reads a .docx that merely embeds a macro-enabled workbook", async () => {
    const docx = await buildDocx({
      body: [{ type: "heading", level: 1, text: "Embeds A Workbook" }],
      contentTypeOverrides: [
        {
          partName: "/word/embeddings/Microsoft_Excel_Sheet.xlsm",
          contentType: "application/vnd.ms-excel.sheet.macroEnabled.12",
        },
      ],
    });

    await expect(readWordOutline(docx)).resolves.toMatchObject({
      chapters: [expect.objectContaining({ title: "Embeds A Workbook" })],
    });
  });

  it("throws legacy_format for a synthetic OLE .doc header", async () => {
    // Synthetic: a real .doc has a full CFB directory; this is just the
    // 8-byte magic number plus filler.
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(64),
    ]);

    expect(await readCode(readWordOutline(ole))).toBe("legacy_format");
  });

  it("throws encrypted for an OLE container carrying the EncryptedPackage marker", async () => {
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(32),
      Buffer.from("EncryptedPackage", "utf16le"),
      Buffer.alloc(32),
    ]);

    expect(await readCode(readWordOutline(ole))).toBe("encrypted");
  });

  it("throws malformed for a package without word/document.xml", async () => {
    const docx = await buildDocx({ omitDocument: true });

    expect(await readCode(readWordOutline(docx))).toBe("malformed");
  });

  it("throws malformed for malformed document XML, without leaking a marker from it", async () => {
    const docx = await buildDocx({
      documentXml: '<w:document><w:body><w:p MARKER_SECRET_XYZ="1">',
    });

    expect(await readCode(readWordOutline(docx))).toBe("malformed");
    const message = await readMessage(readWordOutline(docx));
    expect(message).not.toContain("MARKER_SECRET_XYZ");
  });

  it("rejects any DOCTYPE before parsing, even one xmldom would accept", async () => {
    const docx = await buildDocx({
      documentXml: `<?xml version="1.0"?><!DOCTYPE w:document>
${documentXml(renderBlocks([{ type: "heading", level: 1, text: "Doctype" }]))
  .split("\n")
  .slice(1)
  .join("\n")}`,
    });

    const parseSpy = vi.spyOn(DOMParser.prototype, "parseFromString");
    try {
      expect(await readCode(readWordOutline(docx))).toBe("malformed");
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("throws malformed for a part declaring a DOCTYPE with internal entities", async () => {
    const entities = Array.from(
      { length: 9 },
      (_value, index) =>
        `<!ENTITY lol${index + 1} "&lol${index};&lol${index};&lol${index};&lol${index};&lol${index};&lol${index};&lol${index};&lol${index};&lol${index};&lol${index};">`,
    ).join("");
    const docx = await buildDocx({
      documentXml: `<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY lol "lol">${entities}]>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&lol9;</w:t></w:r></w:p></w:body></w:document>`,
    });

    expect(await readCode(readWordOutline(docx))).toBe("malformed");
  });

  it("throws malformed for document XML that is not valid UTF-8", async () => {
    const docx = await buildDocx({
      omitDocument: true,
      extraParts: {
        "word/document.xml": Uint8Array.from([0xff, 0xfe, 0x41, 0x00]),
      },
    });

    expect(await readCode(readWordOutline(docx))).toBe("malformed");
  });

  it("throws encrypted for a password-protected archive entry", async () => {
    const docx = await buildDocx({ body: TEMPLATE_BODY });
    const bytes = Buffer.from(docx);
    const entry = bytes.indexOf(CENTRAL_SIGNATURE);
    expect(entry).toBeGreaterThan(0);
    bytes.writeUInt16LE(1, entry + 8);

    expect(await readCode(readWordOutline(bytes))).toBe("encrypted");
  });

  it("rejects a zip bomb via assertReadableArchive before any XML is parsed", async () => {
    const docx = await buildDocx({ body: TEMPLATE_BODY });
    const bomb = Buffer.from(docx);
    const entry = bomb.indexOf(CENTRAL_SIGNATURE);
    expect(entry).toBeGreaterThan(0);
    bomb.writeUInt32LE(512 * 1024 * 1024, entry + 24);

    const parseSpy = vi.spyOn(DOMParser.prototype, "parseFromString");
    try {
      expect(await readCode(readWordOutline(bomb))).toBe("resource_limit");
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });
  it("refuses a part that inflates past the 16 MiB per-part byte bound", async () => {
    expect(WORD_PART_MAX_BYTES).toBe(16 * 1024 * 1024);
    const docx = await buildDocx({
      documentXml: documentXml(
        `<w:p><w:r><w:t>${"x".repeat(WORD_PART_MAX_BYTES + 1)}</w:t></w:r></w:p>`,
      ),
    });

    expect(await readCode(readWordOutline(docx))).toBe("resource_limit");
  });
});

describe("unreadable secondary parts", () => {
  const BODY: DocxBlockSpec[] = [
    { type: "heading", level: 1, text: "Chapter One" },
    { type: "paragraph", style: "guidance", text: "Guidance paragraph." },
    { type: "paragraph", text: "Findable body sentence." },
  ];

  it("reads the document when word/styles.xml does not parse", async () => {
    const docx = await buildDocx({
      body: BODY,
      styles: '<w:styles><w:style w:styleId="guidance"',
    });

    // The style index is simply empty; everything else reads as usual.
    await expect(readWordOutline(docx)).resolves.toMatchObject({
      chapters: [expect.objectContaining({ title: "Chapter One" })],
    });
    await expect(readWordInstructions(docx, {})).resolves.toMatchObject({
      totalItems: 1,
    });
  });

  it("reads the document when word/styles.xml is not valid UTF-8", async () => {
    const docx = await buildDocx({
      body: BODY,
      styles: false,
      extraParts: {
        "word/styles.xml": Uint8Array.from([0xff, 0xfe, 0x41, 0x00]),
      },
    });

    await expect(readWordOutline(docx)).resolves.toMatchObject({
      chapters: [expect.objectContaining({ title: "Chapter One" })],
    });
  });

  it("returns no comments when word/comments.xml does not parse", async () => {
    const docx = await buildDocx({
      body: BODY,
      extraParts: { "word/comments.xml": "<w:comments><w:comment" },
    });

    await expect(readWordInstructions(docx, {})).resolves.toMatchObject({
      comments: [],
    });
  });

  it("still searches the body when a header part does not parse", async () => {
    const docx = await buildDocx({
      body: BODY,
      extraParts: { "word/header1.xml": "<w:hdr><w:p" },
    });

    await expect(
      searchWordText(docx, { query: "findable" }),
    ).resolves.toMatchObject({
      total: 1,
      matches: [{ location: "body", blockId: "p-003" }],
    });
  });

  it("still fails the read for a DOCTYPE in a secondary part", async () => {
    const docx = await buildDocx({
      body: BODY,
      styles:
        '<?xml version="1.0"?><!DOCTYPE w:styles [<!ENTITY lol "lol">]><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" />',
    });

    expect(await readCode(readWordOutline(docx))).toBe("malformed");
  });
});

describe("large documents", () => {
  it("assigns the nearest enclosing chapter to every block of a many-chapter document", async () => {
    const chapterCount = 240;
    const paragraphsPerChapter = 12;
    const body: DocxBlockSpec[] = [];
    for (let chapter = 0; chapter < chapterCount; chapter += 1) {
      body.push({
        type: "heading",
        level: (chapter % 3) + 1,
        text: `Chapter ${chapter}`,
      });
      for (let index = 0; index < paragraphsPerChapter; index += 1) {
        body.push({
          type: "paragraph",
          style: "guidance",
          text: `c${chapter}-p${index}`,
        });
      }
    }
    const docx = await buildDocx({ body });

    const result = await readWordInstructions(docx, {});

    expect(result.totalItems).toBe(chapterCount * paragraphsPerChapter);
    const items = result.groups.flatMap((group) => group.items);
    // Every paragraph belongs to the heading immediately above it, whatever
    // the nesting of the enclosing levels.
    const misattributed = items.filter((item) => {
      const chapter = Number(/^c(\d+)-p\d+$/.exec(item.text)?.[1]);
      return (
        item.chapterId !== `chapter-${String(chapter + 1).padStart(3, "0")}`
      );
    });
    expect(misattributed).toEqual([]);

    const outline = await readWordOutline(docx);
    expect(outline.chapters).toHaveLength(chapterCount);
    expect(outline.chapters.at(-1)).toMatchObject({
      chapterId: `chapter-${chapterCount}`,
      title: `Chapter ${chapterCount - 1}`,
      instructionParagraphCount: paragraphsPerChapter,
    });
  });
});

describe("chapter ranges at scale", () => {
  /** Groups of 1 -> 2 -> 3 -> 2, so every group exercises the 3 -> 2 unwind
   *  and the return to level 1 at the next group. */
  const GROUPS = 1_000;
  const BLOCKS_PER_GROUP = 8;

  function groupedBody(): DocxBlockSpec[] {
    const body: DocxBlockSpec[] = [];
    for (let group = 0; group < GROUPS; group += 1) {
      for (const level of [1, 2, 3, 2]) {
        body.push({ type: "heading", level, text: `g${group}-h${level}` });
        body.push({ type: "paragraph", text: `g${group}-body${level}` });
      }
    }
    return body;
  }

  it("ends every chapter at the next heading of the same or a shallower level", async () => {
    const docx = await buildDocx({ body: groupedBody() });
    const pkg = loadDocx(docx);
    const sheet = loadStyleSheet(pkg);
    const structure = buildStructure(pkg.doc, {
      styles: sheet.index,
      defaultSize: sheet.defaultSize,
    });
    const blockCount = GROUPS * BLOCKS_PER_GROUP;

    expect(structure.blocks).toHaveLength(blockCount);
    expect(structure.chapters).toHaveLength(GROUPS * 4);

    const ranges = structure.chapters.map((chapter) => [
      chapter.startBlockIndex,
      chapter.endBlockIndex,
    ]);
    const expected: number[][] = [];
    for (let group = 0; group < GROUPS; group += 1) {
      const base = group * BLOCKS_PER_GROUP;
      const nextGroup = Math.min(base + BLOCKS_PER_GROUP, blockCount);
      expected.push(
        [base, nextGroup], // level 1 runs to the next level-1 heading
        [base + 2, base + 6], // level 2 runs to the next level-2 heading
        [base + 4, base + 6], // level 3 unwinds at that same level-2 heading
        [base + 6, nextGroup], // the second level 2 runs to the next group
      );
    }
    expect(ranges).toEqual(expected);
  });
});

describe("deeply nested XML", () => {
  it("maps the stack overflow of the recursive element walk to resource_limit", async () => {
    const depth = 50_000;
    const nested = `${"<w:sdt><w:sdtContent>".repeat(depth)}<w:p><w:r><w:t>deep</w:t></w:r></w:p>${"</w:sdtContent></w:sdt>".repeat(depth)}`;
    const docx = await buildDocx({ documentXml: documentXml(nested) });

    expect(await readCode(readWordOutline(docx))).toBe("resource_limit");
  });
});

describe("style sheet typography", () => {
  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22" /></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Abschnitt">
    <w:name w:val="Abschnitt" />
    <w:pPr><w:outlineLvl w:val="1" /></w:pPr>
    <w:rPr><w:b /><w:sz w:val="32" /></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Unterabschnitt">
    <w:name w:val="Unterabschnitt" />
    <w:basedOn w:val="Abschnitt" />
  </w:style>
</w:styles>`;

  it("records size, bold, outline level and the document default size", async () => {
    const sheet = loadStyleSheet(loadDocx(await buildDocx({ styles: STYLES })));
    expect(sheet.defaultSize).toBe(22);
    const style = sheet.index.get("Abschnitt")!;
    expect(style.outlineLevel).toBe(1);
    expect(style.format.size).toBe(32);
    expect(style.format.bold).toBe(true);
    expect(sheet.index.get("Unterabschnitt")!.outlineLevel).toBeNull();
  });

  it("ignores a font size of 0 in document defaults and styles", async () => {
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="0" /></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Zero"><w:name w:val="Zero" /><w:rPr><w:sz w:val="0" /></w:rPr></w:style>
</w:styles>`;
    const sheet = loadStyleSheet(loadDocx(await buildDocx({ styles })));
    expect(sheet.defaultSize).toBe(20);
    expect(sheet.index.get("Zero")!.format.size).toBeUndefined();
  });

  it("reads an outline level inherited through a basedOn chain as a declared heading", async () => {
    const outline = await readWordOutline(
      await buildDocx({
        styles: STYLES,
        body: [
          { type: "paragraph", text: "Geltungsbereich", style: "Abschnitt" },
          { type: "paragraph", text: "Im Rahmen." },
          { type: "paragraph", text: "Details", style: "Unterabschnitt" },
          { type: "paragraph", text: "Mehr." },
        ],
      }),
    );
    expect(outline.headingSource).toBe("styles");
    expect(outline.chapters.map((c) => [c.title, c.level, c.inferred])).toEqual(
      [
        ["Geltungsbereich", 2, undefined],
        ["Details", 2, undefined],
      ],
    );
  });

  it("falls back to 20 half-points without document defaults", async () => {
    const sheet = loadStyleSheet(loadDocx(await buildDocx({ styles: false })));
    expect(sheet.defaultSize).toBe(20);
    expect(sheet.index.size).toBe(0);
  });
});

describe("heading detection without Heading N styles", () => {
  const body = (text: string): DocxBlockSpec => ({
    type: "paragraph",
    runs: [{ text, size: 22 }],
  });
  const sized = (text: string, size: number, bold = false): DocxBlockSpec => ({
    type: "paragraph",
    runs: [{ text, size, bold }],
  });

  const filler = (count: number): DocxBlockSpec[] =>
    Array.from({ length: count }, (_, i) =>
      body(`Ordinary body sentence number ${i + 1} of this passage.`),
    );

  it("reads a paragraph outline level as a declared heading", async () => {
    const outline = await readWordOutline(
      await buildDocx({
        body: [
          { type: "paragraph", text: "Scope", outlineLevel: 0 },
          body("In scope."),
          { type: "paragraph", text: "Details", outlineLevel: 1 },
          body("More."),
        ],
      }),
    );
    expect(outline.headingSource).toBe("styles");
    expect(outline.chapters.map((c) => [c.title, c.level])).toEqual([
      ["Scope", 1],
      ["Details", 2],
    ]);
    expect(outline.chapters[0]!.inferred).toBeUndefined();
  });

  it("infers chapters from font size and bold-only lines", async () => {
    const outline = await readWordOutline(
      await buildDocx({
        body: [
          sized("Certificate change tool", 40),
          body("Dienstag, 7. Dezember 2021"),
          ...filler(2),
          sized("GIT project", 32, true),
          body("The script is maintained in a git project."),
          ...filler(2),
          sized("Logging", 22, true),
          body("The script logs to three locations."),
          ...filler(2),
          sized("Java versions to use", 40),
          body("The DMZ node requires the bundled JRE."),
          ...filler(2),
        ],
      }),
    );
    expect(outline.headingSource).toBe("inferred");
    expect(
      outline.chapters.map((c) => [c.chapterId, c.title, c.level, c.inferred]),
    ).toEqual([
      ["chapter-001", "Certificate change tool", 1, true],
      ["chapter-002", "GIT project", 2, true],
      ["chapter-003", "Logging", 3, true],
      ["chapter-004", "Java versions to use", 1, true],
    ]);
    // heading + date + 2 + GIT + body + 2 + Logging + body + 2 blocks
    expect(outline.chapters[0]!.blockCount).toBe(12);
  });

  it("does not infer when declared headings exist", async () => {
    const outline = await readWordOutline(
      await buildDocx({
        body: [
          { type: "heading", level: 1, text: "Real" },
          sized("Big but not a heading", 40),
          body("Text."),
        ],
      }),
    );
    expect(outline.headingSource).toBe("styles");
    expect(outline.chapters.map((c) => c.title)).toEqual(["Real"]);
  });

  it("keeps document-body when formatting is too loose to be an outline", async () => {
    const outline = await readWordOutline(
      await buildDocx({
        body: [
          sized("Loud line one", 40),
          sized("Loud line two", 40),
          body("Only one normal paragraph."),
        ],
      }),
    );
    expect(outline.headingSource).toBe("none");
    expect(outline.chapters.map((c) => c.chapterId)).toEqual(["document-body"]);
  });

  it("keeps the outline of a document whose body paragraphs are long", async () => {
    const prose = "This sentence is part of a long body paragraph. ".repeat(6);
    expect(prose.trim().length).toBeGreaterThan(280);
    const outline = await readWordOutline(
      await buildDocx({
        body: Array.from({ length: 5 }, (_, chapter) => [
          sized(`Section ${chapter + 1}`, 32),
          ...Array.from({ length: 4 }, () => body(prose)),
        ]).flat(),
      }),
    );
    expect(outline.headingSource).toBe("inferred");
    expect(outline.chapters.map((c) => c.title)).toEqual([
      "Section 1",
      "Section 2",
      "Section 3",
      "Section 4",
      "Section 5",
    ]);
  });

  it("does not read outline level 9 as a heading", async () => {
    const outline = await readWordOutline(
      await buildDocx({
        body: [
          { type: "paragraph", text: "Body text level", outlineLevel: 9 },
          { type: "paragraph", text: "More body text." },
        ],
      }),
    );
    expect(outline.headingSource).toBe("none");
    expect(outline.chapters.map((c) => c.chapterId)).toEqual(["document-body"]);
  });

  it("does not take an explicitly non-bold line as a bold-only heading", async () => {
    const run = (props: string, text: string) =>
      `<w:p><w:r><w:rPr>${props}<w:sz w:val="22" /></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
    const outline = await readWordOutline(
      await buildDocx({
        documentXml: documentXml(
          [
            run("<w:b />", "First topic"),
            renderBlocks(filler(3)),
            run('<w:b w:val="0" />', "Not a topic"),
            renderBlocks(filler(3)),
            run('<w:b w:val="true" />', "Second topic"),
            renderBlocks(filler(3)),
          ].join(""),
        ),
      }),
    );
    expect(outline.headingSource).toBe("inferred");
    expect(outline.chapters.map((c) => c.title)).toEqual([
      "First topic",
      "Second topic",
    ]);
  });

  it("ignores a run size of 0 and uses the style's size instead", async () => {
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22" /></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Big"><w:name w:val="Big" /><w:rPr><w:sz w:val="40" /></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="BigChild"><w:name w:val="BigChild" /><w:basedOn w:val="Big" /><w:rPr><w:sz w:val="0" /></w:rPr></w:style>
</w:styles>`;
    const zeroRun = (style: string, text: string) =>
      `<w:p><w:pPr><w:pStyle w:val="${style}" /></w:pPr><w:r><w:rPr><w:sz w:val="0" /></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
    const outline = await readWordOutline(
      await buildDocx({
        styles,
        documentXml: documentXml(
          [
            zeroRun("Big", "Alpha"),
            renderBlocks(filler(3)),
            zeroRun("BigChild", "Omega"),
            renderBlocks(filler(3)),
          ].join(""),
        ),
      }),
    );
    expect(outline.headingSource).toBe("inferred");
    expect(outline.chapters.map((c) => c.title)).toEqual(["Alpha", "Omega"]);
  });

  it("ignores long, punctuated and table-cell text", async () => {
    const outline = await readWordOutline(
      await buildDocx({
        body: [
          sized("Overview", 40),
          body("Intro."),
          ...filler(6),
          sized("Note:", 22, true),
          sized("x".repeat(121), 40),
          {
            type: "table",
            rows: [[{ paragraphs: [{ runs: [{ text: "Cell", size: 40 }] }] }]],
          },
          sized("Appendix", 40),
          body("Outro."),
          ...filler(2),
        ],
      }),
    );
    expect(outline.chapters.map((c) => c.title)).toEqual([
      "Overview",
      "Appendix",
    ]);
  });

  it("reads an inferred chapter by its id", async () => {
    const data = await buildDocx({
      body: [
        sized("First", 40),
        body("Alpha."),
        ...filler(2),
        sized("Second", 40),
        body("Beta."),
        ...filler(2),
      ],
    });
    const chapter = await readWordChapter(data, { chapterId: "chapter-002" });
    expect(chapter.title).toBe("Second");
    expect(chapter.blocks.map((b) => b.type === "paragraph" && b.text)).toEqual(
      [
        "Beta.",
        "Ordinary body sentence number 1 of this passage.",
        "Ordinary body sentence number 2 of this passage.",
      ],
    );
  });

  it("takes the smaller size as the body size when characters tie", async () => {
    const outline = await readWordOutline(
      await buildDocx({
        body: [
          sized("Alpha heading", 40),
          body("Text."),
          body("Text."),
          body("Text."),
          sized("Omega heading", 40),
          body("Text."),
          body("Text."),
          body("x"),
        ],
      }),
    );
    expect(outline.headingSource).toBe("inferred");
    expect(outline.chapters.map((c) => c.title)).toEqual([
      "Alpha heading",
      "Omega heading",
    ]);
  });
});

describe("readWordBlocks", () => {
  const data = () =>
    buildDocx({
      body: [
        { type: "heading", level: 1, text: "One" },
        { type: "paragraph", text: "a" },
        { type: "paragraph", text: "b" },
        { type: "heading", level: 1, text: "Two" },
        { type: "paragraph", text: "c" },
        { type: "table", rows: [["h"], ["v"]] },
        { type: "paragraph", text: "d" },
      ],
    });
  const texts = (read: Awaited<ReturnType<typeof readWordBlocks>>) =>
    read.blocks.map((b) => (b.type === "paragraph" ? b.text : b.tableId));

  it("reads across chapter boundaries from any block", async () => {
    const read = await readWordBlocks(await data(), { fromBlockId: "p-003" });
    expect(read.startBlockId).toBe("p-003");
    expect(read.startChapter).toEqual({
      chapterId: "chapter-001",
      title: "One",
      level: 1,
    });
    expect(texts(read)).toEqual(["b", "Two", "c", "table-001", "d"]);
    expect(read.blockCount).toBe(5);
    expect(read.nextBlock).toBeNull();
  });

  it("honours toBlockId, before and paging", async () => {
    const bytes = await data();
    const ranged = await readWordBlocks(bytes, {
      fromBlockId: "p-005",
      toBlockId: "table-001",
      before: 1,
    });
    expect(ranged.startBlockId).toBe("p-004");
    expect(texts(ranged)).toEqual(["Two", "c", "table-001"]);

    const first = await readWordBlocks(bytes, {
      fromBlockId: "p-001",
      maxBlocks: 2,
    });
    expect(texts(first)).toEqual(["One", "a"]);
    expect(first.nextBlock).toBe(2);
    const second = await readWordBlocks(bytes, {
      fromBlockId: "p-001",
      maxBlocks: 2,
      fromBlock: first.nextBlock!,
    });
    expect(texts(second)).toEqual(["b", "Two"]);
  });

  it("rejects unknown and reversed block ids", async () => {
    const bytes = await data();
    expect(
      await readCode(readWordBlocks(bytes, { fromBlockId: "p-999" })),
    ).toBe("not_found");
    expect(
      await readCode(
        readWordBlocks(bytes, { fromBlockId: "p-005", toBlockId: "p-002" }),
      ),
    ).toBe("invalid_input");
    expect(
      await readCode(
        readWordBlocks(bytes, { fromBlockId: "p-001", before: 21 }),
      ),
    ).toBe("invalid_input");
  });

  it("rejects a negative or fractional lead-in and an unknown end block", async () => {
    const bytes = await data();
    for (const before of [-1, 1.5])
      expect(
        await readCode(readWordBlocks(bytes, { fromBlockId: "p-002", before })),
      ).toBe("invalid_input");
    expect(
      await readCode(
        readWordBlocks(bytes, { fromBlockId: "p-002", toBlockId: "p-999" }),
      ),
    ).toBe("not_found");
  });

  it("reports the range start even when the instruction filter drops that block", async () => {
    const read = await readWordBlocks(
      await buildDocx({
        body: [
          { type: "heading", level: 1, text: "One" },
          { type: "paragraph", text: "Replace this text.", style: "guidance" },
          { type: "paragraph", text: "kept" },
        ],
      }),
      { fromBlockId: "p-002", excludeInstructions: true },
    );
    expect(read.startBlockId).toBe("p-002");
    expect(read.startChapter).toMatchObject({ chapterId: "chapter-001" });
    expect(read.blocks.map((b) => b.blockId)).toEqual(["p-003"]);
  });

  it("names the chapter on a search match", async () => {
    const result = await searchWordText(await data(), { query: "c" });
    expect(result.matches[0]).toMatchObject({
      chapterId: "chapter-002",
      chapterTitle: "Two",
      blockId: "p-005",
    });
  });
});

describe("Word images", () => {
  const png = (label: string) =>
    Buffer.concat([PNG_SIGNATURE, Buffer.from(label)]);
  const sha = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");

  it("reports body images with id, type, size and alt text", async () => {
    const shot = png("screenshot");
    const data = await buildDocx({
      images: { rId7: { target: "media/image1.png", bytes: shot } },
      body: [
        { type: "paragraph", text: "Example:" },
        { type: "paragraph", image: { relId: "rId7", alt: "Login dialog" } },
        { type: "paragraph", text: "After.", image: { relId: "rId7" } },
      ],
    });
    const { blocks } = await readWordBlocks(data, { fromBlockId: "p-001" });
    expect(blocks[0]).not.toHaveProperty("images");
    expect(blocks[1]).toMatchObject({
      text: "",
      images: [
        {
          imageId: sha(shot),
          contentType: "image/png",
          byteSize: shot.byteLength,
          alt: "Login dialog",
        },
      ],
    });
    expect(blocks[2]).toMatchObject({
      text: "After.",
      images: [{ imageId: sha(shot), alt: "" }],
    });
  });

  it("warns instead of failing for images it cannot return", async () => {
    const data = await buildDocx({
      images: {
        rEmf: {
          target: "media/image1.emf",
          bytes: Buffer.from("not an image"),
        },
        rLink: { target: "https://example.invalid/a.png", external: true },
        rGone: { target: "media/missing.png" },
      },
      body: [
        { type: "paragraph", image: { relId: "rEmf", vml: true } },
        { type: "paragraph", image: { relId: "rLink" } },
        { type: "paragraph", image: { relId: "rGone" } },
        { type: "paragraph", image: { relId: "rUnknown" } },
      ],
    });
    const { blocks } = await readWordBlocks(data, { fromBlockId: "p-001" });
    expect(
      blocks.map((b) => (b.type === "paragraph" ? b.imageWarnings : null)),
    ).toEqual([
      ["unsupported image format was omitted"],
      ["image data is not included in the file"],
      ["image data is not included in the file"],
      ["image data is not included in the file"],
    ]);
    expect(blocks.every((b) => !("images" in b))).toBe(true);
  });

  it("recognises JPEG, GIF and WebP pictures by their signature", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const gif = Buffer.from("GIF89a-pixels", "latin1");
    const webp = Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1");
    const data = await buildDocx({
      images: {
        rJpeg: { target: "media/image1.bin", bytes: jpeg },
        rGif: { target: "media/image2.bin", bytes: gif },
        rWebp: { target: "media/image3.bin", bytes: webp },
      },
      body: [
        { type: "paragraph", image: { relId: "rJpeg" } },
        { type: "paragraph", image: { relId: "rGif" } },
        { type: "paragraph", image: { relId: "rWebp" } },
      ],
    });
    const { blocks } = await readWordBlocks(data, { fromBlockId: "p-001" });
    expect(
      blocks.map((b) =>
        b.type === "paragraph"
          ? b.images?.map((i) => [i.contentType, i.imageId])
          : null,
      ),
    ).toEqual([
      [["image/jpeg", sha(jpeg)]],
      [["image/gif", sha(gif)]],
      [["image/webp", sha(webp)]],
    ]);
  });

  it("does not report a picture whose part lies outside word/media", async () => {
    const shot = png("elsewhere");
    const data = await buildDocx({
      images: {
        rEmbedded: { target: "embeddings/image1.png", bytes: shot },
        rNested: { target: "media/sub/image1.png", bytes: shot },
        rRoot: { target: "/media/image1.png" },
      },
      extraParts: { "media/image1.png": shot },
      body: [
        { type: "paragraph", image: { relId: "rEmbedded" } },
        { type: "paragraph", image: { relId: "rNested" } },
        { type: "paragraph", image: { relId: "rRoot" } },
      ],
    });
    const { blocks } = await readWordBlocks(data, { fromBlockId: "p-001" });
    expect(
      blocks.map((b) => (b.type === "paragraph" ? b.imageWarnings : null)),
    ).toEqual([
      ["image data is not included in the file"],
      ["image data is not included in the file"],
      ["image data is not included in the file"],
    ]);
    expect(blocks.every((b) => !("images" in b))).toBe(true);
  });

  it("tells a picture that is too large from one that cannot be read", async () => {
    const data = await buildDocx({
      images: {
        rBig: { target: "media/big.png", bytes: png("x".repeat(600)) },
        rBroken: { target: "media/broken.png", bytes: png("broken") },
        rFine: { target: "media/fine.png", bytes: png("fine") },
      },
      body: [
        { type: "paragraph", image: { relId: "rBig" } },
        { type: "paragraph", image: { relId: "rBroken" } },
        { type: "paragraph", image: { relId: "rFine" } },
      ],
    });
    // An unsupported compression method makes the entry unreadable.
    data.writeUInt16LE(99, data.lastIndexOf("word/media/broken.png") - 46 + 10);
    const pkg = loadDocx(data);
    const sheet = loadStyleSheet(pkg);
    const { blocks } = buildStructure(pkg.doc, {
      styles: sheet.index,
      defaultSize: sheet.defaultSize,
    });
    const resolver = createImageResolver(pkg, 512);
    expect(blocks.map((block) => resolver.read(block.element))).toEqual([
      { images: [], warnings: ["image is too large"] },
      { images: [], warnings: ["image data is not included in the file"] },
      {
        images: [expect.objectContaining({ contentType: "image/png" })],
        warnings: [],
      },
    ]);
  });

  it("counts images in a table block and returns them with the rows", async () => {
    const shot = png("cell");
    const data = await buildDocx({
      images: { rId1: { target: "media/image1.png", bytes: shot } },
      body: [
        {
          type: "table",
          rows: [
            ["Step", "Screen"],
            [
              "Open",
              { paragraphs: [{ image: { relId: "rId1", alt: "Menu" } }] },
            ],
          ],
        },
      ],
    });
    const { blocks } = await readWordBlocks(data, { fromBlockId: "table-001" });
    expect(blocks[0]).toMatchObject({ type: "table", imageCount: 1 });
    const table = await readWordTable(data, { tableId: "table-001" });
    expect(table.images).toEqual([
      {
        rowIndex: 2,
        columnIndex: 2,
        imageId: sha(shot),
        contentType: "image/png",
        byteSize: shot.byteLength,
        alt: "Menu",
      },
    ]);
  });

  it("returns header pictures when the data-row window is empty", async () => {
    const shot = png("header-only");
    const data = await buildDocx({
      images: { rId1: { target: "media/header.png", bytes: shot } },
      body: [
        {
          type: "table",
          rows: [[{ paragraphs: [{ image: { relId: "rId1" } }] }]],
        },
      ],
    });
    const table = await readWordTable(data, {
      tableId: "table-001",
      fromRow: 1,
      includeHeaderImages: true,
    });
    expect(table.header).toEqual([""]);
    expect(table.rows).toEqual([]);
    expect(table.nextRow).toBeNull();
    expect(table.images).toEqual([
      expect.objectContaining({
        rowIndex: 1,
        columnIndex: 1,
        imageId: sha(shot),
      }),
    ]);
  });

  it("adds header pictures without changing data windows or repeating them on continuation", async () => {
    const data = await buildDocx({
      images: {
        header: { target: "media/header.png", bytes: png("header") },
        first: { target: "media/first.png", bytes: png("first") },
        second: { target: "media/second.png", bytes: png("second") },
      },
      body: [
        {
          type: "table",
          rows: ["header", "first", "second"].map((relId) => [
            { paragraphs: [{ text: relId, image: { relId } }] },
          ]),
        },
      ],
    });
    const first = await readWordTable(data, {
      tableId: "table-001",
      fromRow: 1,
      maxRows: 1,
      includeHeaderImages: true,
    });
    expect(first.rows).toEqual([["first"]]);
    expect(first.nextRow).toBe(2);
    expect(first.images?.map((image) => image.rowIndex)).toEqual([1, 2]);

    const next = await readWordTable(data, {
      tableId: "table-001",
      fromRow: first.nextRow!,
      maxRows: 1,
    });
    expect(next.rows).toEqual([["second"]]);
    expect(next.nextRow).toBeNull();
    expect(next.images?.map((image) => image.rowIndex)).toEqual([3]);

    const rowZero = await readWordTable(data, {
      tableId: "table-001",
      maxRows: 1,
    });
    const rowOne = await readWordTable(data, {
      tableId: "table-001",
      fromRow: rowZero.nextRow!,
      maxRows: 1,
    });
    expect(rowZero.images?.map((image) => image.rowIndex)).toEqual([1]);
    expect(rowOne.images?.map((image) => image.rowIndex)).toEqual([2]);
  });

  it("inspects at most 200 distinct media parts per read", async () => {
    const images: Record<string, { target: string; bytes: Buffer }> = {};
    const body: DocxBlockSpec[] = [];
    for (let i = 1; i <= 201; i++) {
      images[`rId${i}`] = { target: `media/i${i}.png`, bytes: png(`n${i}`) };
      body.push({ type: "paragraph", image: { relId: `rId${i}` } });
    }
    body.push({ type: "paragraph", image: { relId: "rId1" } });
    const data = await buildDocx({ images, body });
    const { blocks } = await readWordBlocks(data, {
      fromBlockId: "p-001",
      maxBlocks: 500,
    });
    const withImages = blocks.filter((b) => "images" in b);
    expect(withImages).toHaveLength(201);
    expect(blocks[199]).toHaveProperty("images");
    expect(blocks[200]).not.toHaveProperty("images");
    expect(blocks[200]).toMatchObject({
      imageWarnings: ["more images were omitted"],
    });
    expect(blocks[201]).toMatchObject({
      images: [{ imageId: sha(png("n1")) }],
    });
  });

  const drawing = (relId: string, descr?: string) =>
    `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">${
      descr === undefined ? "" : `<wp:docPr id="1" name="P" descr="${descr}" />`
    }<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${relId}" /></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

  it("does not carry alt text over to the next picture", async () => {
    const shot = png("two");
    const data = await buildDocx({
      images: { rId1: { target: "media/image1.png", bytes: shot } },
      documentXml: documentXml(
        `<w:p>${drawing("rId1", "First")}${drawing("rId1")}</w:p>`,
      ),
    });
    const { blocks } = await readWordBlocks(data, { fromBlockId: "p-001" });
    expect(blocks[0]).toMatchObject({
      images: [{ alt: "First" }, { alt: "" }],
    });
  });

  it("reports a picture once when VML fallback repeats it", async () => {
    const shot = png("alt");
    const choice = `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="wps">${drawing("rId1", "Pic")}</mc:Choice><mc:Fallback><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" alt="Pic"><v:imagedata xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1" /></v:shape></w:pict></w:r></mc:Fallback></mc:AlternateContent>`;
    const data = await buildDocx({
      images: { rId1: { target: "media/image1.png", bytes: shot } },
      documentXml: documentXml(
        `<w:p>${choice}</w:p><w:tbl><w:tr><w:tc><w:p>${choice}</w:p></w:tc></w:tr></w:tbl>`,
      ),
    });
    const { blocks } = await readWordBlocks(data, { fromBlockId: "p-001" });
    expect(blocks[0]).toMatchObject({ images: [{ alt: "Pic" }] });
    expect((blocks[0] as { images: unknown[] }).images).toHaveLength(1);
    expect(blocks[1]).toMatchObject({ type: "table", imageCount: 1 });
  });
});
