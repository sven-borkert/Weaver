import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  buildDocx,
  PNG_SIGNATURE,
} from "@weaver/artifact-readers/testing/docxFixture";
import { buildTestPdf } from "@weaver/artifact-readers/testing/pdfFixture";
import { buildXlsx } from "@weaver/artifact-readers/testing/xlsxFixture";
import { parseServerEnv } from "@weaver/config/server";
import { resolveScopeSnapshot } from "@weaver/core/assistant/scope";
import { openUploadSink } from "@weaver/core/ingestion/blobStore";
import { blobPath } from "@weaver/core/ingestion/paths";
import { finalizeArtifactUpload } from "@weaver/core/services/artifacts";
import { getDocumentAtSnapshot } from "@weaver/core/services/documents";
import { importDocumentFile } from "@weaver/core/services/documentImport";
import { encodeArtifactCursor } from "@weaver/core/services/artifactCursors";
import { cursorQueryIdentity } from "@weaver/core/services/contentCursors";
import {
  describeArtifact,
  readArtifact,
} from "@weaver/core/services/artifactReads";
import type { runArtifactReader } from "@weaver/core/artifacts/readerProcess";
import {
  MAX_TOOL_OUTPUT_CHARS,
  toolErrorFromUnknown,
  type ToolContext,
} from "@weaver/assistant-tools/contract";
import {
  ASSISTANT_TOOLS,
  MCP_TOOLS,
  toolByName,
} from "@weaver/assistant-tools/registry";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

const DATA_DIR = process.env.WEAVER_DATA_DIR!;

async function stage(projectId: string, content: Uint8Array | Buffer | string) {
  const uploadId = randomUUID();
  const sink = await openUploadSink(DATA_DIR, projectId, uploadId, {
    minFreeBytes: 0,
  });
  await sink.write(
    typeof content === "string" ? new TextEncoder().encode(content) : content,
  );
  const { digest, byteSize } = await sink.finish();
  return { uploadId, contentDigest: digest, byteSize };
}

async function members(suffix: string) {
  const project = await makeProject(`Artifact reads ${suffix}`);
  const editor = await makeUser("User", `ar-ed-${suffix}`);
  const viewer = await makeUser("User", `ar-vw-${suffix}`);
  const outsider = await makeUser("User", `ar-out-${suffix}`);
  await addMembership(project.id, editor.id, "Editor");
  await addMembership(project.id, viewer.id, "Viewer");
  return {
    project,
    editor: securityContextFor(editor),
    viewer: securityContextFor(viewer),
    outsider: securityContextFor(outsider),
  };
}

async function storeArtifact(
  projectId: string,
  editor: ReturnType<typeof securityContextFor>,
  filename: string,
  content: Uint8Array | Buffer | string,
) {
  const staged = await stage(projectId, content);
  const { artifacts } = await finalizeArtifactUpload(
    getPrisma(),
    editor,
    { projectId, files: [{ ...staged, filename, replace: false }] },
    { dataDir: DATA_DIR },
  );
  return { artifact: artifacts[0]!, digest: staged.contentDigest };
}

async function replaceArtifact(
  projectId: string,
  editor: ReturnType<typeof securityContextFor>,
  filename: string,
  content: Uint8Array | Buffer | string,
) {
  const staged = await stage(projectId, content);
  await finalizeArtifactUpload(
    getPrisma(),
    editor,
    { projectId, files: [{ ...staged, filename, replace: true }] },
    { dataDir: DATA_DIR },
  );
}

async function toolFixture(suffix: string) {
  const db = getPrisma();
  const people = await members(suffix);
  const scope = await resolveScopeSnapshot(db, people.viewer, {
    kind: "project",
    projectId: people.project.id,
  });
  const ctx: ToolContext = {
    db,
    actor: people.viewer,
    scope,
    profile: { name: "Viewer", email: "viewer@example.test" },
    run: null,
  };
  return { db, ...people, scope, ctx };
}

/** Runs a registered tool through its own input schema and holds every result
 *  to the budget both transports clamp at. */
async function call<T>(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<T> {
  const tool = toolByName(name)!;
  const outcome = await tool.execute(tool.inputSchema.parse(input), ctx);
  // Bytes, the unit the prompt budget charges a tool result in.
  expect(
    Buffer.byteLength(JSON.stringify(outcome.output), "utf8"),
  ).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
  return outcome.output as T;
}

function execute(name: string, input: unknown, ctx: ToolContext) {
  const tool = toolByName(name)!;
  return tool.execute(tool.inputSchema.parse(input), ctx);
}

/** Every file tool answers `{ artifact, result }` (design §7.3). */
type Nested<R> = {
  artifact: {
    id: string;
    filename: string;
    contentType: string;
    byteSize: number;
    sha256: string;
    updatedAt: string;
    url: string;
  };
  result: R;
};

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

type ExcelOverview = {
  format: string;
  truncated: boolean;
  warnings: string[];
  warningsTruncated: boolean;
  sheets: Array<{
    index: number;
    name: string;
    rowCount: number;
    columnCount: number;
    empty: boolean;
    truncated: boolean;
    headers: Array<string | null>;
  }>;
  sheetsTruncated: boolean;
  omittedSheetCount: number;
  omittedSheets: Array<{ index: number; name: string }>;
  omittedSheetsTruncated: boolean;
};

type JsonQuery = {
  path: string;
  total: number;
  offset: number;
  nextOffset: number | null;
  nextCursor: string | null;
  hasMore: boolean;
  truncated: boolean;
  items: unknown[];
};

type PdfPages = {
  pageCount: number;
  startPage: number;
  endPage: number;
  pages: Array<{ page: number; text: string }>;
  omittedPageTail: number | null;
  nextCursor: string | null;
  hasMore: boolean;
  truncated: boolean;
};

type WordChapter = {
  format: string;
  chapterId: string;
  title: string;
  level: number;
  blockCount: number;
  startIndex: number;
  blocks: Array<{
    blockId: string;
    type: string;
    kind?: string;
    text?: string;
    tableId?: string;
    rowCount?: number;
    columnCount?: number;
    values?: string[][];
    clamped?: boolean;
    omitted?: boolean;
    hint?: string;
  }>;
  truncated: boolean;
  hasMore: boolean;
  nextCursor: string | null;
};

type WordTableCandidates = {
  format: string;
  truncated: boolean;
  warnings: string[];
  candidates: Array<{
    tableId: string;
    caption: string | null;
    chapterTitle: string | null;
    rows: number;
    columns: number;
    headerRow?: string[];
    score: number;
    matchReasons: string[];
  }>;
};

type WordTable = {
  format: string;
  tableId: string;
  rowCount: number;
  columnCount: number;
  header: string[] | null;
  headerTruncated: boolean;
  startRow: number | null;
  rows: Array<{ row: number; values: string[]; clamped?: boolean }>;
  dropdowns?: Array<{
    controlId: string;
    selectedText: string;
    options?: Array<{ value: string; displayText: string }>;
  }>;
  truncated: boolean;
  hasMore: boolean;
  nextCursor: string | null;
};

type ExcelRows = {
  format: string;
  sheetName: string | null;
  range: string | null;
  startRow: number | null;
  endRow: number | null;
  rows: Array<{ sheet?: string; row: number; values: Array<string | null> }>;
  truncated: boolean;
  hasMore: boolean;
  nextCursor: string | null;
};

/** One minimal valid input per file tool, for the access-check tables. */
const TOOL_INPUTS = [
  ["search_artifacts", {}],
  ["get_artifact_overview", { filename: "data.json" }],
  ["search_artifact_text", { filename: "data.json", query: "x" }],
  ["query_json_artifact", { filename: "data.json", path: "$.a" }],
  ["read_text_artifact", { filename: "data.json" }],
  ["read_csv_artifact", { filename: "data.json" }],
  ["inspect_structured_artifact", { filename: "data.json" }],
  ["read_pdf_pages", { filename: "brief.pdf" }],
  ["read_word_chapter", { filename: "plan.docx", chapterId: "chapter-001" }],
  ["read_word_blocks", { filename: "plan.docx", fromBlockId: "p-001" }],
  ["find_word_tables", { filename: "plan.docx", query: "owner" }],
  ["read_word_table", { filename: "plan.docx", tableId: "table-001" }],
  ["read_excel_sheet", { filename: "book.xlsx" }],
] as const;

const SUITE_MAX_FILE_BYTES = process.env.WEAVER_INGESTION_MAX_FILE_BYTES!;

describe("services/artifactReads", () => {
  // The suite-wide 1024-byte WEAVER_INGESTION_MAX_FILE_BYTES (see
  // vitest.integration.config.ts) is far below a real .docx/.xlsx's floor.
  // services/artifactReads.ts reads config fresh per call (no memoization),
  // so stubbing/unstubbing around this describe block is leak-free even
  // though the integration config runs every spec file in one process
  // (isolate: false) — verified below by re-reading the config after unstub.
  beforeAll(() => {
    vi.stubEnv("WEAVER_INGESTION_MAX_FILE_BYTES", "1048576");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    expect(parseServerEnv(process.env).WEAVER_INGESTION_MAX_FILE_BYTES).toBe(
      Number(SUITE_MAX_FILE_BYTES),
    );
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("reads a stored JSON artifact for a Viewer and returns the envelope", async () => {
    const db = getPrisma();
    const { project, editor, viewer } = await members("json-happy");
    const { artifact, digest } = await storeArtifact(
      project.id,
      editor,
      "data.json",
      '{"a":1,"b":[1,2,3]}',
    );

    const result = await readArtifact(
      db,
      viewer,
      { projectId: project.id, filename: "data.json" },
      "json.overview",
      {},
    );

    expect(result.artifact).toMatchObject({
      id: artifact.id,
      projectId: project.id,
      filename: "data.json",
      contentType: "application/json",
      byteSize: artifact.byteSize,
      sha256: digest,
    });
    expect(typeof result.artifact.updatedAt).toBe("string");
    expect(result.value).toMatchObject({
      rootType: "object",
      topLevel: [
        { key: "a", type: "number" },
        { key: "b", type: "array", count: 3 },
      ],
    });
  });

  it("reads a stored Word artifact for one operation", async () => {
    const db = getPrisma();
    const { project, editor, viewer } = await members("word-happy");
    const docx = await buildDocx({
      body: [{ type: "heading", level: 1, text: "Introduction" }],
    });
    await storeArtifact(project.id, editor, "report.docx", docx);

    const result = await readArtifact(
      db,
      viewer,
      { projectId: project.id, filename: "report.docx" },
      "word.outline",
      {},
    );

    expect(result.artifact.filename).toBe("report.docx");
    expect(result.value).toMatchObject({
      chapters: [expect.objectContaining({ title: "Introduction" })],
    });
  });

  it("reads a stored Excel artifact for one operation", async () => {
    const db = getPrisma();
    const { project, editor, viewer } = await members("excel-happy");
    const xlsx = await buildXlsx([
      {
        name: "Sheet1",
        rows: [
          ["Name", "Role"],
          ["Ada", "Engineer"],
        ],
      },
    ]);
    await storeArtifact(project.id, editor, "book.xlsx", xlsx);

    const result = await readArtifact(
      db,
      viewer,
      { projectId: project.id, filename: "book.xlsx" },
      "excel.overview",
      {},
    );

    expect(result.artifact.filename).toBe("book.xlsx");
    expect(result.value).toMatchObject({
      sheets: [expect.objectContaining({ name: "Sheet1" })],
    });
  });

  it("reads a stored PDF artifact for one operation", async () => {
    const db = getPrisma();
    const { project, editor, viewer } = await members("pdf-happy");
    const pdf = buildTestPdf(["Page one text"]);
    await storeArtifact(project.id, editor, "brief.pdf", pdf);

    const result = await readArtifact(
      db,
      viewer,
      { projectId: project.id, filename: "brief.pdf" },
      "pdf.summary",
      {},
    );

    expect(result.artifact.filename).toBe("brief.pdf");
    expect(result.value).toMatchObject({ pageCount: 1, totalChars: 13 });
  });

  it("describes an artifact and its format without reading its content", async () => {
    const db = getPrisma();
    const { project, editor, viewer } = await members("describe");
    await storeArtifact(project.id, editor, "data.json", "{}");

    const result = await describeArtifact(db, viewer, {
      projectId: project.id,
      filename: "data.json",
    });

    expect(result.format).toBe("json");
    expect(result.artifact.filename).toBe("data.json");
  });

  it("refuses an outsider with NOT_FOUND before spawning any reader", async () => {
    const db = getPrisma();
    const { project, editor, outsider } = await members("outsider");
    await storeArtifact(project.id, editor, "data.json", "{}");

    let spawned = false;
    const runReader: typeof runArtifactReader = async () => {
      spawned = true;
      return { ok: true, value: null };
    };

    await expect(
      readArtifact(
        db,
        outsider,
        { projectId: project.id, filename: "data.json" },
        "json.overview",
        {},
        { runReader },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(spawned).toBe(false);
  });

  it("rejects an operation whose format does not match the file", async () => {
    const db = getPrisma();
    const { project, editor, viewer } = await members("wrong-format");
    await storeArtifact(project.id, editor, "data.json", "{}");

    await expect(
      readArtifact(
        db,
        viewer,
        { projectId: project.id, filename: "data.json" },
        "word.outline",
        {},
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { expectedFormat: "word", actualFormat: "json" },
    });
  });

  it("reports NOT_FOUND for an unknown filename", async () => {
    const db = getPrisma();
    const { project, viewer } = await members("unknown");

    await expect(
      readArtifact(
        db,
        viewer,
        { projectId: project.id, filename: "missing.json" },
        "json.overview",
        {},
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reports NOT_FOUND when the blob on disk no longer matches the digest", async () => {
    const db = getPrisma();
    const { project, editor, viewer } = await members("tampered");
    const { digest } = await storeArtifact(
      project.id,
      editor,
      "data.json",
      "original content",
    );
    await writeFile(
      blobPath(DATA_DIR, project.id, digest),
      "different bytes entirely, of another length",
    );

    await expect(
      readArtifact(
        db,
        viewer,
        { projectId: project.id, filename: "data.json" },
        "json.overview",
        {},
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "file content is no longer stored",
    });
  });

  it("maps a malformed JSON file to BAD_REQUEST with the reader's own message", async () => {
    const db = getPrisma();
    const { project, editor, viewer } = await members("malformed");
    await storeArtifact(project.id, editor, "bad.json", "{not valid json");

    await expect(
      readArtifact(
        db,
        viewer,
        { projectId: project.id, filename: "bad.json" },
        "json.overview",
        {},
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("artifact is not valid JSON"),
    });
  });

  it("turns a crashed reader into the generic INTERNAL tool error", async () => {
    const db = getPrisma();
    const { project, editor, viewer } = await members("crashed");
    await storeArtifact(project.id, editor, "data.json", '{"a":1}');
    // The tools have no runner seam of their own; this is the same failure a
    // forked child that dies produces, mapped by the same two functions the
    // tool adapters use.
    const runReader: typeof runArtifactReader = async () => ({
      ok: false,
      failure: {
        code: "unavailable",
        cause: "crashed",
        message: "reading the file failed",
        exitCode: 1,
        signal: null,
      },
    });

    const thrown = await readArtifact(
      db,
      viewer,
      { projectId: project.id, filename: "data.json" },
      "json.overview",
      {},
      { runReader },
    ).catch((error: unknown) => error);

    expect(thrown).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    const toolError = toolErrorFromUnknown(thrown);
    expect(toolError).toMatchObject({
      code: "INTERNAL",
      message: "tool failed",
    });
    expect(toolError.reason).toBeUndefined();
    expect(JSON.stringify(toolError.message)).not.toMatch(
      /crash|exit|signal|too long|memory/i,
    );
  });

  it("maps a resource_limit failure to BAD_REQUEST with reason PAYLOAD_TOO_LARGE", async () => {
    const db = getPrisma();
    const { project, editor, viewer } = await members("resource-limit");
    await storeArtifact(project.id, editor, "data.json", '{"a":1}');

    await expect(
      readArtifact(
        db,
        viewer,
        { projectId: project.id, filename: "data.json" },
        "json.query",
        {
          path: "$.a",
          fields: Array.from({ length: 21 }, (_v, i) => `f${i}`),
        },
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "PAYLOAD_TOO_LARGE" },
    });
  });
});

describe("artifact read tools", () => {
  beforeAll(() => {
    vi.stubEnv("WEAVER_INGESTION_MAX_FILE_BYTES", "1048576");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    expect(parseServerEnv(process.env).WEAVER_INGESTION_MAX_FILE_BYTES).toBe(
      Number(SUITE_MAX_FILE_BYTES),
    );
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("lists a project's files with a readable flag and a filename filter", async () => {
    const { project, editor, ctx } = await toolFixture("list");
    await storeArtifact(project.id, editor, "data.json", '{"a":1}');
    await storeArtifact(project.id, editor, "notes.txt", "plain text");
    await storeArtifact(
      project.id,
      editor,
      "report.docx",
      await buildDocx({ body: [{ type: "heading", level: 1, text: "Hi" }] }),
    );

    const all = await call<{
      page: number;
      total: number;
      truncated: boolean;
      items: Array<{
        id: string;
        filename: string;
        contentType: string;
        byteSize: number;
        updatedAt: string;
        readable: boolean;
      }>;
    }>("search_artifacts", { projectId: project.id }, ctx);

    expect(all).toMatchObject({ page: 1, total: 3, truncated: false });
    expect(all.items.map((item) => item.filename)).toEqual([
      "data.json",
      "notes.txt",
      "report.docx",
    ]);
    expect(all.items.map((item) => item.readable)).toEqual([true, true, true]);
    expect(typeof all.items[0]!.updatedAt).toBe("string");

    const filtered = await call<{ total: number; items: Array<unknown> }>(
      "search_artifacts",
      { projectId: project.id, query: "note" },
      ctx,
    );
    expect(filtered.total).toBe(1);
  });

  it("overviews a JSON file's top-level keys", async () => {
    const { project, editor, ctx } = await toolFixture("json-overview");
    await storeArtifact(project.id, editor, "data.json", '{"a":1,"b":[1,2,3]}');

    const output = await call<
      Nested<{
        readable: boolean;
        format: string;
        rootType: string;
        topLevel: Array<{ key: string; type: string; count: number | null }>;
      }>
    >(
      "get_artifact_overview",
      { projectId: project.id, filename: "data.json" },
      ctx,
    );

    expect(output.artifact).toMatchObject({
      filename: "data.json",
      contentType: "application/json",
      url: `/projects/${project.id}/artifacts?file=data.json`,
    });
    expect(typeof output.artifact.sha256).toBe("string");
    expect(output.result).toMatchObject({
      readable: true,
      format: "json",
      rootType: "object",
    });
    expect(output.result.topLevel).toEqual([
      { key: "a", type: "number", count: null },
      { key: "b", type: "array", count: 3 },
    ]);
  });

  it("overviews a Word file's chapters and tables", async () => {
    const { project, editor, ctx } = await toolFixture("word-overview");
    await storeArtifact(
      project.id,
      editor,
      "plan.docx",
      await buildDocx({
        body: [
          { type: "heading", level: 1, text: "Introduction" },
          { type: "paragraph", text: "Weaver stores project files." },
          { type: "heading", level: 2, text: "Scope" },
          {
            type: "table",
            rows: [
              ["Item", "Owner"],
              ["Reader", "Ada"],
            ],
          },
        ],
      }),
    );

    const { result } = await call<
      Nested<{
        format: string;
        chapters: Array<{ chapterId: string; level: number; title: string }>;
        chaptersTruncated: boolean;
        tables: Array<{ tableId: string; rows: number; columns: number }>;
        tablesTruncated: boolean;
        hint: string;
      }>
    >(
      "get_artifact_overview",
      { projectId: project.id, filename: "plan.docx" },
      ctx,
    );

    expect(result.format).toBe("word");
    expect(result.chapters.map((chapter) => chapter.title)).toEqual([
      "Introduction",
      "Scope",
    ]);
    expect(result.chaptersTruncated).toBe(false);
    expect(result.tables).toEqual([
      expect.objectContaining({ tableId: "table-001", rows: 2, columns: 2 }),
    ]);
    expect(result.tablesTruncated).toBe(false);
    expect(result.hint).toContain("find_word_tables");
  });

  it("overviews a Word file that opens with text before its first heading", async () => {
    const { project, editor, ctx } = await toolFixture("word-front-matter");
    await storeArtifact(
      project.id,
      editor,
      "preface.docx",
      await buildDocx({
        body: [
          { type: "paragraph", text: "Issued by the platform team." },
          { type: "heading", level: 1, text: "Introduction" },
          { type: "paragraph", text: "Weaver stores project files." },
        ],
      }),
    );
    const target = { projectId: project.id, filename: "preface.docx" };

    const { result } = await call<
      Nested<{
        outlineSource: string;
        chapters: Array<Record<string, unknown>>;
      }>
    >("get_artifact_overview", target, ctx);

    expect(result.outlineSource).toBe("styles");
    expect(result.chapters[0]).toMatchObject({ chapterId: "chapter-000" });
    expect(result.chapters[0]).not.toHaveProperty("blockId");
    expect(result.chapters[1]).toMatchObject({
      chapterId: "chapter-001",
      title: "Introduction",
      blockId: "p-002",
    });

    const blocks = await call<
      Nested<{
        startChapter: { chapterId: string } | null;
        blocks: Array<{ blockId: string; chapterId?: string }>;
      }>
    >("read_word_blocks", { ...target, fromBlockId: "p-001" }, ctx);
    expect(blocks.result.startChapter).toMatchObject({
      chapterId: "chapter-000",
    });
    expect(blocks.result.blocks.map((block) => block.blockId)).toEqual([
      "p-001",
      "p-002",
      "p-003",
    ]);
  });

  it("overviews and reads a Word file without any heading", async () => {
    const { project, editor, ctx } = await toolFixture("word-headingless");
    await storeArtifact(
      project.id,
      editor,
      "memo.docx",
      await buildDocx({
        body: [
          { type: "paragraph", text: "The first plain sentence of the memo." },
          { type: "paragraph", text: "The second plain sentence of the memo." },
        ],
      }),
    );
    const target = { projectId: project.id, filename: "memo.docx" };

    const { result } = await call<
      Nested<{
        outlineSource: string;
        chapters: Array<Record<string, unknown>>;
      }>
    >("get_artifact_overview", target, ctx);

    expect(result.outlineSource).toBe("none");
    expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0]).toMatchObject({ chapterId: "document-body" });
    expect(result.chapters[0]).not.toHaveProperty("blockId");

    const chapter = await call<
      Nested<{ chapterId: string; blocks: Array<{ text?: string }> }>
    >("read_word_chapter", { ...target, chapterId: "document-body" }, ctx);
    expect(chapter.result.chapterId).toBe("document-body");
    expect(chapter.result.blocks.map((block) => block.text)).toEqual([
      "The first plain sentence of the memo.",
      "The second plain sentence of the memo.",
    ]);

    const blocks = await call<
      Nested<{ startChapter: { chapterId: string } | null }>
    >("read_word_blocks", { ...target, fromBlockId: "p-002" }, ctx);
    expect(blocks.result.startChapter).toMatchObject({
      chapterId: "document-body",
    });
  });

  it("overviews an Excel workbook's sheets", async () => {
    const { project, editor, ctx } = await toolFixture("excel-overview");
    await storeArtifact(
      project.id,
      editor,
      "book.xlsx",
      await buildXlsx([
        {
          name: "People",
          rows: [
            ["Name", "Role"],
            ["Ada", "Engineer"],
          ],
        },
        { name: "Empty", rows: [] },
      ]),
    );

    const { result } = await call<Nested<ExcelOverview>>(
      "get_artifact_overview",
      { projectId: project.id, filename: "book.xlsx" },
      ctx,
    );

    expect(result.format).toBe("excel");
    expect(result.sheets.map((sheet) => sheet.name)).toEqual([
      "People",
      "Empty",
    ]);
    expect(result.sheets[0]!.headers).toEqual(["Name", "Role"]);
    expect(result.sheets[0]!.truncated).toBe(false);
    expect(result.sheets[1]!.empty).toBe(true);
    expect(result.sheetsTruncated).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.omittedSheetCount).toBe(0);
    expect(result.omittedSheets).toEqual([]);
  });

  it("bounds a workbook whose omitted-sheet list dwarfs the budget", async () => {
    const { project, editor, ctx } = await toolFixture("excel-many-sheets");
    // The reader keeps the first 50 sheets and lists every other one as
    // omitted, so the omitted list is what has to be bounded here.
    await storeArtifact(
      project.id,
      editor,
      "wide.xlsx",
      await buildXlsx(
        Array.from({ length: 400 }, (_value, index) => ({
          name: `Sheet number ${index + 1}`,
          rows: [["Name", "Role"]],
        })),
      ),
    );

    const output = await call<Nested<ExcelOverview>>(
      "get_artifact_overview",
      { projectId: project.id, filename: "wide.xlsx" },
      ctx,
    );

    expect(output.result.omittedSheetCount).toBe(350);
    expect(output.result.omittedSheets.length).toBeLessThan(350);
    expect(output.result.omittedSheetsTruncated).toBe(true);
    expect(output.result.truncated).toBe(true);
    expect(output.result.warnings[0]).toContain("omitted");
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(16_000);
  });

  it("overviews a PDF's pages", async () => {
    const { project, editor, ctx } = await toolFixture("pdf-overview");
    await storeArtifact(
      project.id,
      editor,
      "brief.pdf",
      buildTestPdf(["Page one text", "Page two text"]),
    );

    const { result } = await call<
      Nested<{
        format: string;
        pageCount: number;
        totalChars: number;
        pages: Array<{ page: number; chars: number }>;
        pagesTruncated: boolean;
        warnings: string[];
        warningsTruncated: boolean;
      }>
    >(
      "get_artifact_overview",
      { projectId: project.id, filename: "brief.pdf" },
      ctx,
    );

    expect(result.format).toBe("pdf");
    expect(result.pageCount).toBe(2);
    expect(result.pages.map((page) => page.page)).toEqual([1, 2]);
    expect(result.totalChars).toBeGreaterThan(0);
    expect(result.pagesTruncated).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.warningsTruncated).toBe(false);
  });

  it("reports a file type no reader handles without reading its bytes", async () => {
    const { project, editor, ctx } = await toolFixture("unreadable");
    await storeArtifact(project.id, editor, "diagram.png", PNG_BYTES);

    const output = await call<Nested<{ readable: boolean; format: null }>>(
      "get_artifact_overview",
      { projectId: project.id, filename: "diagram.png" },
      ctx,
    );

    expect(output.result).toEqual({ readable: false, format: null });
    expect(output.artifact.contentType).toBe("image/png");
  });

  it("bounds an overview of a document with two thousand chapters", async () => {
    const { project, editor, ctx } = await toolFixture("huge-outline");
    await storeArtifact(
      project.id,
      editor,
      "huge.docx",
      await buildDocx({
        body: Array.from({ length: 2_000 }, (_value, index) => ({
          type: "heading" as const,
          level: 1,
          text: `Chapter ${index + 1}`,
        })),
      }),
    );

    const { result } = await call<
      Nested<{
        chapters: Array<{ title: string }>;
        chaptersTruncated: boolean;
      }>
    >(
      "get_artifact_overview",
      { projectId: project.id, filename: "huge.docx" },
      ctx,
    );

    expect(result.chapters.length).toBeGreaterThan(10);
    expect(result.chapters.length).toBeLessThan(2_000);
    expect(result.chapters[0]!.title).toBe("Chapter 1");
    expect(result.chaptersTruncated).toBe(true);
  });

  it("still lists the chapters after a 20,000-character heading", async () => {
    const { project, editor, ctx } = await toolFixture("huge-heading");
    await storeArtifact(
      project.id,
      editor,
      "heading.docx",
      await buildDocx({
        body: [
          { type: "heading" as const, level: 1, text: "H".repeat(20_000) },
          ...Array.from({ length: 5 }, (_value, index) => ({
            type: "heading" as const,
            level: 1,
            text: `Chapter ${index + 2}`,
          })),
        ],
      }),
    );

    const { result } = await call<
      Nested<{
        chapters: Array<{ title: string; titleTruncated?: true }>;
        chaptersTruncated: boolean;
      }>
    >(
      "get_artifact_overview",
      { projectId: project.id, filename: "heading.docx" },
      ctx,
    );

    // A single unbounded title would have been the whole page and, since
    // boundItems keeps a prefix, every chapter after it would be gone.
    expect(result.chapters).toHaveLength(6);
    expect(result.chapters[0]).toMatchObject({
      title: "H".repeat(200),
      titleTruncated: true,
    });
    expect(result.chapters[1]).toEqual(
      expect.not.objectContaining({ titleTruncated: true }),
    );
    expect(result.chapters.at(-1)!.title).toBe("Chapter 6");
    expect(result.chaptersTruncated).toBe(false);
  });

  it("returns Word images as weaver-image references a write can copy", async () => {
    const { project, editor, ctx } = await toolFixture("word-images");
    const shot = Buffer.concat([PNG_SIGNATURE, Buffer.from("tool-shot")]);
    const imageId = createHash("sha256").update(shot).digest("hex");
    const { artifact } = await storeArtifact(
      project.id,
      editor,
      "manual.docx",
      await buildDocx({
        images: {
          rId1: { target: "media/image1.png", bytes: shot },
          rId2: {
            target: "media/image2.bmp",
            bytes: Buffer.from("BM-not-supported"),
          },
        },
        body: [
          { type: "heading", level: 1, text: "Steps" },
          {
            type: "paragraph",
            text: "Open the menu [x]:",
            image: { relId: "rId1", alt: "Menu [main]" },
          },
          {
            type: "paragraph",
            text: "Odd format:",
            image: { relId: "rId2" },
          },
          {
            type: "table",
            rows: [
              ["Screen"],
              [{ paragraphs: [{ image: { relId: "rId1" } }] }],
            ],
          },
        ],
      }),
    );
    const target = { projectId: project.id, filename: "manual.docx" };
    const reference = `weaver-image:${artifact.id}/${imageId}`;

    const chapter = await call<{
      result: { blocks: Array<Record<string, unknown>> };
    }>("read_word_chapter", { ...target, chapterId: "chapter-001" }, ctx);
    expect(chapter.result.blocks[0]).toMatchObject({
      text: "Open the menu [x]:",
      images: [
        {
          markdown: `![Menu \\[main\\]](${reference})`,
          contentType: "image/png",
          byteSize: shot.byteLength,
        },
      ],
    });
    expect(chapter.result.blocks[1]).toMatchObject({
      text: "Odd format:",
      imageWarnings: ["unsupported image format was omitted"],
    });
    expect(chapter.result.blocks[2]).toMatchObject({
      type: "table",
      imageCount: 1,
    });

    const table = await call<{
      result: { images: Array<Record<string, unknown>> };
    }>("read_word_table", { ...target, tableId: "table-001" }, ctx);
    expect(table.result.images).toEqual([
      {
        rowIndex: 2,
        columnIndex: 1,
        markdown: `![Image](${reference})`,
        contentType: "image/png",
        byteSize: shot.byteLength,
      },
    ]);

    const imported = await importDocumentFile(
      ctx.db,
      {
        projectId: project.id,
        folderPath: [],
        fileName: "copy.md",
        text: `# Copy\n\n${(chapter.result.blocks[0] as { images: Array<{ markdown: string }> }).images[0]!.markdown}\n`,
      },
      { ...editor, name: "Editor", email: "editor@example.test" },
    );
    const written = await getDocumentAtSnapshot(
      ctx.db,
      { projectId: project.id, documentId: imported.id },
      editor,
    );
    expect(written.markdown).not.toContain("weaver-image:");
    expect(written.markdown).toContain("copy.assets/image.png");
  });

  it.each([0, 205])(
    "returns a Word table header picture once while preserving all %i data rows",
    async (dataRowCount) => {
      const { project, editor, ctx } = await toolFixture(
        `word-header-image-${dataRowCount}`,
      );
      const shot = Buffer.concat([PNG_SIGNATURE, Buffer.from("header-shot")]);
      const imageId = createHash("sha256").update(shot).digest("hex");
      const { artifact } = await storeArtifact(
        project.id,
        editor,
        "header.docx",
        await buildDocx({
          images: { header: { target: "media/header.png", bytes: shot } },
          body: [
            {
              type: "table",
              rows: [
                [
                  {
                    paragraphs: [{ image: { relId: "header", alt: "Header" } }],
                  },
                ],
                ...Array.from({ length: dataRowCount }, (_, index) => [
                  `Data ${index + 1}`,
                ]),
              ],
            },
          ],
        }),
      );
      let cursor: string | undefined;
      let pages = 0;
      const rows: WordTable["rows"] = [];
      do {
        const { result } = await call<
          Nested<WordTable & { images?: Array<Record<string, unknown>> }>
        >(
          "read_word_table",
          {
            projectId: project.id,
            filename: "header.docx",
            tableId: "table-001",
            ...(cursor ? { cursor } : {}),
          },
          ctx,
        );
        if (pages === 0)
          expect(result.images).toEqual([
            {
              rowIndex: 1,
              columnIndex: 1,
              markdown: `![Header](weaver-image:${artifact.id}/${imageId})`,
              contentType: "image/png",
              byteSize: shot.byteLength,
            },
          ]);
        else expect(result.images).toBeUndefined();
        rows.push(...result.rows);
        cursor = result.nextCursor ?? undefined;
        pages += 1;
      } while (cursor && pages < 10);

      expect(cursor).toBeUndefined();
      expect(rows).toEqual(
        Array.from({ length: dataRowCount }, (_, index) => ({
          row: index + 2,
          values: [`Data ${index + 1}`],
        })),
      );
      if (dataRowCount > 0) expect(pages).toBeGreaterThan(1);
    },
  );

  it("searches the text of a Word file", async () => {
    const { project, editor, ctx } = await toolFixture("word-search");
    await storeArtifact(
      project.id,
      editor,
      "plan.docx",
      await buildDocx({
        body: [
          { type: "heading", level: 1, text: "Introduction" },
          { type: "paragraph", text: "Weaver stores project files." },
        ],
      }),
    );

    const { artifact, result } = await call<
      Nested<{
        format: string;
        total: number;
        truncated: boolean;
        matches: Array<{ snippet: string; location: string }>;
      }>
    >(
      "search_artifact_text",
      { projectId: project.id, filename: "plan.docx", query: "stores" },
      ctx,
    );

    expect(artifact.filename).toBe("plan.docx");
    expect(result.format).toBe("word");
    expect(result.total).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.matches[0]!.snippet).toContain("stores");
  });

  it("searches the text of a PDF and reports the page", async () => {
    const { project, editor, ctx } = await toolFixture("pdf-search");
    await storeArtifact(
      project.id,
      editor,
      "brief.pdf",
      buildTestPdf(["alpha beta", "gamma beta"]),
    );

    const { result } = await call<
      Nested<{
        format: string;
        total: number;
        matches: Array<{ page: number; snippet: string }>;
      }>
    >(
      "search_artifact_text",
      { projectId: project.id, filename: "brief.pdf", query: "beta" },
      ctx,
    );

    expect(result.format).toBe("pdf");
    expect(result.total).toBe(2);
    expect(result.matches.map((match) => match.page)).toEqual([1, 2]);
  });

  it("refuses a text search on a spreadsheet and names read_excel_sheet", async () => {
    const { project, editor, ctx } = await toolFixture("search-wrong-format");
    await storeArtifact(
      project.id,
      editor,
      "book.xlsx",
      await buildXlsx([{ name: "Sheet1", rows: [["Name"]] }]),
    );

    await expect(
      execute(
        "search_artifact_text",
        { projectId: project.id, filename: "book.xlsx", query: "Name" },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        "search_artifact_text reads Word, PDF, text, Markdown, CSV, YAML and OneNote files; for an Excel file use read_excel_sheet",
    });
  });

  it("queries JSON with a JSONPath expression and pages by cursor", async () => {
    const { project, editor, ctx } = await toolFixture("json-query");
    await storeArtifact(
      project.id,
      editor,
      "data.json",
      JSON.stringify({
        items: [
          { id: 1, name: "one", extra: "x" },
          { id: 2, name: "two", extra: "y" },
          { id: 3, name: "three", extra: "z" },
        ],
      }),
    );

    const first = await call<Nested<JsonQuery>>(
      "query_json_artifact",
      {
        projectId: project.id,
        filename: "data.json",
        path: "$.items[*]",
        fields: ["name"],
        limit: 2,
      },
      ctx,
    );

    expect(first.result).toMatchObject({
      path: "$.items[*]",
      total: 3,
      offset: 0,
      nextOffset: 2,
      hasMore: true,
      truncated: true,
    });
    expect(first.result.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(first.result.items).toEqual([{ name: "one" }, { name: "two" }]);

    const second = await call<Nested<JsonQuery>>(
      "query_json_artifact",
      {
        projectId: project.id,
        filename: "data.json",
        path: "$.items[*]",
        fields: ["name"],
        limit: 2,
        cursor: first.result.nextCursor!,
      },
      ctx,
    );
    expect(second.result).toMatchObject({
      offset: 2,
      nextOffset: null,
      nextCursor: null,
      hasMore: false,
    });
    expect(second.result.items).toEqual([{ name: "three" }]);

    // A repeated offset must agree with the cursor; a changed projection
    // (part of the cursor's query binding) is a different read entirely.
    await expect(
      execute(
        "query_json_artifact",
        {
          projectId: project.id,
          filename: "data.json",
          path: "$.items[*]",
          fields: ["name"],
          offset: 1,
          cursor: first.result.nextCursor!,
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "INVALID_CURSOR" },
    });
    await expect(
      execute(
        "query_json_artifact",
        {
          projectId: project.id,
          filename: "data.json",
          path: "$.items[*]",
          fields: ["id"],
          cursor: first.result.nextCursor!,
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "INVALID_CURSOR" },
    });
  });

  it("rejects a JSON cursor whose file was replaced between pages", async () => {
    const { project, editor, ctx } = await toolFixture("json-stale");
    await storeArtifact(
      project.id,
      editor,
      "data.json",
      JSON.stringify({ items: [{ n: 1 }, { n: 2 }, { n: 3 }] }),
    );
    const first = await call<Nested<JsonQuery>>(
      "query_json_artifact",
      {
        projectId: project.id,
        filename: "data.json",
        path: "$.items[*]",
        limit: 2,
      },
      ctx,
    );
    expect(first.result.nextCursor).not.toBeNull();

    await replaceArtifact(
      project.id,
      editor,
      "data.json",
      JSON.stringify({ items: [{ n: 9 }] }),
    );

    await expect(
      execute(
        "query_json_artifact",
        {
          projectId: project.id,
          filename: "data.json",
          path: "$.items[*]",
          limit: 2,
          cursor: first.result.nextCursor,
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "STALE_BASE" },
    });
  });

  it("clamps a single oversized JSON match and still advances one item", async () => {
    const { project, editor, ctx } = await toolFixture("json-oversized");
    await storeArtifact(
      project.id,
      editor,
      "big.json",
      JSON.stringify({
        items: [{ blob: "x".repeat(50_000) }, { tag: "second" }],
      }),
    );

    const first = await call<Nested<JsonQuery>>(
      "query_json_artifact",
      { projectId: project.id, filename: "big.json", path: "$.items[*]" },
      ctx,
    );

    expect(first.result).toMatchObject({
      total: 2,
      nextOffset: 1,
      truncated: true,
    });
    expect(first.result.items).toHaveLength(1);
    expect(
      (first.result.items[0] as { truncatedJson: string }).truncatedJson,
    ).toMatch(/^\{"blob":"x+/);

    expect(first.result.hasMore).toBe(true);
    const second = await call<Nested<JsonQuery>>(
      "query_json_artifact",
      {
        projectId: project.id,
        filename: "big.json",
        path: "$.items[*]",
        cursor: first.result.nextCursor!,
      },
      ctx,
    );
    expect(second.result.items).toEqual([{ tag: "second" }]);
    expect(second.result.nextOffset).toBeNull();
    expect(second.result.nextCursor).toBeNull();
  });

  it("clamps a match larger than the reader's own byte budget and still advances", async () => {
    const { project, editor, ctx } = await toolFixture("json-reader-clip");
    // 200,000 characters: past the reader's 128 KiB clip, well under the
    // child's 2 MiB result cap.
    await storeArtifact(
      project.id,
      editor,
      "huge.json",
      JSON.stringify({
        items: [{ blob: "x".repeat(200_000) }, { tag: "second" }],
      }),
    );

    const first = await call<Nested<JsonQuery>>(
      "query_json_artifact",
      { projectId: project.id, filename: "huge.json", path: "$.items[*]" },
      ctx,
    );
    expect(first.result).toMatchObject({
      total: 2,
      nextOffset: 1,
      truncated: true,
    });
    expect(first.result.items).toHaveLength(1);
    expect(
      (first.result.items[0] as { truncatedJson: string }).truncatedJson,
    ).toMatch(/^\{"blob":"x+/);

    const second = await call<Nested<JsonQuery>>(
      "query_json_artifact",
      {
        projectId: project.id,
        filename: "huge.json",
        path: "$.items[*]",
        offset: first.result.nextOffset!,
      },
      ctx,
    );
    expect(second.result.items).toEqual([{ tag: "second" }]);
    expect(second.result.nextOffset).toBeNull();
  });

  it("stops after a clamped match that was the last one", async () => {
    const { project, editor, ctx } = await toolFixture("json-oversized-last");
    await storeArtifact(
      project.id,
      editor,
      "big.json",
      JSON.stringify({ items: [{ blob: "x".repeat(50_000) }] }),
    );

    const { result } = await call<Nested<JsonQuery>>(
      "query_json_artifact",
      { projectId: project.id, filename: "big.json", path: "$.items[*]" },
      ctx,
    );

    expect(result).toMatchObject({
      total: 1,
      truncated: true,
      nextOffset: null,
      nextCursor: null,
      hasMore: false,
    });
    expect(result.items).toHaveLength(1);
  });

  it("pages a long PDF and reassembles exactly one full read", async () => {
    const { db, project, editor, viewer, ctx } = await toolFixture("pdf-pages");
    await storeArtifact(
      project.id,
      editor,
      "long.pdf",
      // pdf.js drops glyphs that fall outside the page box, so the fixture's
      // one line per page caps a page at ~68 extracted characters: length has
      // to come from the page count.
      buildTestPdf(
        Array.from(
          { length: 400 },
          (_value, index) => `${index} ${"B".repeat(55)}`,
        ),
      ),
    );
    const whole = await readArtifact(
      db,
      viewer,
      { projectId: project.id, filename: "long.pdf" },
      "pdf.pages",
      { maxChars: 100_000 },
    );
    const expected = (whole.value as { pages: Array<{ text: string }> }).pages
      .map((page) => page.text)
      .join("");
    expect(expected.length).toBeGreaterThan(20_000);

    let cursor: string | undefined;
    let assembled = "";
    let calls = 0;
    do {
      const { result } = await call<Nested<PdfPages>>(
        "read_pdf_pages",
        {
          projectId: project.id,
          filename: "long.pdf",
          ...(cursor === undefined ? {} : { cursor }),
        },
        ctx,
      );
      expect(result.pageCount).toBe(400);
      expect(result.omittedPageTail).toBeNull();
      expect(result.truncated).toBe(result.nextCursor !== null);
      expect(result.hasMore).toBe(result.nextCursor !== null);
      assembled += result.pages.map((entry) => entry.text).join("");
      cursor = result.nextCursor ?? undefined;
      calls += 1;
    } while (cursor !== undefined && calls < 10);

    expect(calls).toBeGreaterThan(2);
    expect(cursor).toBeUndefined();
    expect(assembled).toBe(expected);
  });

  it("honours a page range and reports the last page of it", async () => {
    const { project, editor, ctx } = await toolFixture("pdf-range");
    await storeArtifact(
      project.id,
      editor,
      "brief.pdf",
      buildTestPdf(["one", "two", "three"]),
    );

    const { result } = await call<Nested<PdfPages>>(
      "read_pdf_pages",
      {
        projectId: project.id,
        filename: "brief.pdf",
        startPage: 2,
        endPage: 2,
      },
      ctx,
    );

    expect(result).toMatchObject({
      startPage: 2,
      endPage: 2,
      nextCursor: null,
    });
    expect(result.pages.map((page) => page.page)).toEqual([2]);
  });

  it("rejects a cursor whose file was replaced", async () => {
    const { project, editor, ctx } = await toolFixture("pdf-stale");
    await storeArtifact(
      project.id,
      editor,
      "long.pdf",
      buildTestPdf(
        Array.from(
          { length: 400 },
          (_value, index) => `${index} ${"B".repeat(55)}`,
        ),
      ),
    );
    const first = await call<Nested<PdfPages>>(
      "read_pdf_pages",
      { projectId: project.id, filename: "long.pdf" },
      ctx,
    );
    expect(first.result.nextCursor).not.toBeNull();

    await replaceArtifact(
      project.id,
      editor,
      "long.pdf",
      buildTestPdf(["different text entirely"]),
    );

    await expect(
      execute(
        "read_pdf_pages",
        {
          projectId: project.id,
          filename: "long.pdf",
          cursor: first.result.nextCursor,
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "STALE_BASE" },
    });
  });

  it("replace_between_describe_and_read_is_stale", async () => {
    const { project, editor, ctx } = await toolFixture("race-replace");
    await storeArtifact(
      project.id,
      editor,
      "race.json",
      JSON.stringify({ items: [1, 2, 3] }),
    );
    // Every tool looks the artifact up twice (describe, then read). Replacing
    // the file between those two lookups is only deterministic from inside
    // the second one.
    const db = getPrisma();
    let lookups = 0;
    const racing = new Proxy(db, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (property !== "artifact") return value;
        const model = value as typeof db.artifact;
        return new Proxy(model, {
          get(modelTarget, modelProperty) {
            if (modelProperty !== "findFirst") {
              const passthrough: unknown = Reflect.get(
                modelTarget,
                modelProperty,
              );
              return typeof passthrough === "function"
                ? (passthrough as (...args: never[]) => unknown).bind(
                    modelTarget,
                  )
                : passthrough;
            }
            return async (args: Parameters<typeof model.findFirst>[0]) => {
              const row = await model.findFirst(args);
              lookups += 1;
              if (lookups === 1)
                await replaceArtifact(
                  project.id,
                  editor,
                  "race.json",
                  JSON.stringify({ items: [9] }),
                );
              return row;
            };
          },
        });
      },
    });

    await expect(
      execute(
        "query_json_artifact",
        { projectId: project.id, filename: "race.json", path: "$.items[*]" },
        { ...ctx, db: racing },
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "STALE_BASE" },
    });
    expect(lookups).toBe(2);
  });

  it("rejects a cursor continued with a different endPage", async () => {
    const { project, editor, ctx } = await toolFixture("pdf-endpage-drift");
    await storeArtifact(
      project.id,
      editor,
      "long.pdf",
      buildTestPdf(
        Array.from(
          { length: 400 },
          (_value, index) => `${index} ${"B".repeat(55)}`,
        ),
      ),
    );
    const first = await call<Nested<PdfPages>>(
      "read_pdf_pages",
      { projectId: project.id, filename: "long.pdf", endPage: 400 },
      ctx,
    );
    expect(first.result.nextCursor).not.toBeNull();

    await expect(
      execute(
        "read_pdf_pages",
        {
          projectId: project.id,
          filename: "long.pdf",
          endPage: 399,
          cursor: first.result.nextCursor,
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "INVALID_CURSOR" },
    });
  });

  it("rejects a cursor minted for another tool", async () => {
    const { project, editor, ctx } = await toolFixture("pdf-foreign-cursor");
    const { artifact, digest } = await storeArtifact(
      project.id,
      editor,
      "brief.pdf",
      buildTestPdf(["one"]),
    );
    const foreign = encodeArtifactCursor(
      {
        tool: "read_word_chapter",
        projectId: project.id,
        artifactId: artifact.id,
        contentDigest: digest,
        query: cursorQueryIdentity({ endPage: null }),
      },
      "1:0",
    );

    await expect(
      execute(
        "read_pdf_pages",
        { projectId: project.id, filename: "brief.pdf", cursor: foreign },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "INVALID_CURSOR" },
    });
  });

  it("pages a long Word chapter and reassembles its blocks in order", async () => {
    const { project, editor, ctx } = await toolFixture("word-chapter-paging");
    await storeArtifact(
      project.id,
      editor,
      "long.docx",
      await buildDocx({
        body: [
          { type: "heading", level: 1, text: "Findings" },
          ...Array.from({ length: 600 }, (_value, index) => ({
            type: "paragraph" as const,
            text: `Paragraph ${index + 1} of the findings chapter.`,
          })),
        ],
      }),
    );

    let cursor: string | undefined;
    const seen: string[] = [];
    let calls = 0;
    do {
      const { result } = await call<Nested<WordChapter>>(
        "read_word_chapter",
        {
          projectId: project.id,
          filename: "long.docx",
          chapterId: "chapter-001",
          ...(cursor === undefined ? {} : { cursor }),
        },
        ctx,
      );
      expect(result.blockCount).toBe(600);
      expect(result.title).toBe("Findings");
      expect(result.hasMore).toBe(result.nextCursor !== null);
      for (const block of result.blocks) {
        expect(block.type).toBe("paragraph");
        seen.push(block.blockId);
      }
      cursor = result.nextCursor ?? undefined;
      calls += 1;
    } while (cursor !== undefined && calls < 20);

    expect(calls).toBeGreaterThan(2);
    expect(cursor).toBeUndefined();
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(
      Array.from(
        { length: 600 },
        (_value, index) => `p-${String(index + 2).padStart(3, "0")}`,
      ),
    );
  });

  const sizedPara = (text: string, size: number) => ({
    type: "paragraph" as const,
    runs: [{ text, size }],
  });

  it("browses a Word file that has no heading styles", async () => {
    const { project, editor, ctx } = await toolFixture("word-inferred");
    await storeArtifact(
      project.id,
      editor,
      "notes.docx",
      await buildDocx({
        body: [
          sizedPara("General", 40),
          sizedPara("Shared facts.", 22),
          sizedPara("Applies to every environment.", 22),
          sizedPara("Certificate change tool", 40),
          sizedPara("The script activates a certificate.", 22),
          sizedPara("It must run as user b2bi.", 22),
        ],
      }),
    );
    const target = { projectId: project.id, filename: "notes.docx" };

    const overview = await call<{
      result: {
        outlineSource: string;
        chapters: Array<Record<string, unknown>>;
      };
    }>("get_artifact_overview", target, ctx);
    expect(overview.result.outlineSource).toBe("inferred");
    expect(overview.result.chapters).toEqual([
      {
        chapterId: "chapter-001",
        level: 1,
        title: "General",
        blockId: "p-001",
        blockCount: 3,
        inferred: true,
      },
      {
        chapterId: "chapter-002",
        level: 1,
        title: "Certificate change tool",
        blockId: "p-004",
        blockCount: 3,
        inferred: true,
      },
    ]);

    const search = await call<{
      result: { matches: Array<Record<string, unknown>> };
    }>("search_artifact_text", { ...target, query: "user b2bi" }, ctx);
    expect(search.result.matches[0]).toMatchObject({
      chapterId: "chapter-002",
      chapterTitle: "Certificate change tool",
      blockId: "p-006",
    });

    const blocks = await call<{
      result: {
        startBlockId: string;
        startChapter: { chapterId: string; title: string } | null;
        blockCount: number;
        hasMore: boolean;
        blocks: Array<{ blockId: string; text?: string }>;
      };
    }>("read_word_blocks", { ...target, fromBlockId: "p-006", before: 1 }, ctx);
    expect(blocks.result.startBlockId).toBe("p-005");
    expect(blocks.result.startChapter).toMatchObject({
      chapterId: "chapter-002",
      title: "Certificate change tool",
    });
    expect(blocks.result.blocks.map((b) => b.text)).toEqual([
      "The script activates a certificate.",
      "It must run as user b2bi.",
    ]);
    expect(blocks.result.hasMore).toBe(false);
  });

  it("pages read_word_blocks and rejects a cursor from another range", async () => {
    const { project, editor, ctx } = await toolFixture("word-blocks-paging");
    await storeArtifact(
      project.id,
      editor,
      "long.docx",
      await buildDocx({
        body: Array.from({ length: 700 }, (_value, index) => ({
          type: "paragraph" as const,
          text: `Paragraph ${index} ${"x".repeat(60)}`,
        })),
      }),
    );
    const target = { projectId: project.id, filename: "long.docx" };
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const { result } = await call<{
        result: {
          nextCursor: string | null;
          blocks: Array<{ blockId: string }>;
        };
      }>(
        "read_word_blocks",
        { ...target, fromBlockId: "p-101", ...(cursor ? { cursor } : {}) },
        ctx,
      );
      seen.push(...result.blocks.map((b) => b.blockId));
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(600);
    expect(seen[0]).toBe("p-101");
    expect(seen.at(-1)).toBe("p-700");

    const first = await call<{ result: { nextCursor: string } }>(
      "read_word_blocks",
      { ...target, fromBlockId: "p-101" },
      ctx,
    );
    await expect(
      execute(
        "read_word_blocks",
        { ...target, fromBlockId: "p-102", cursor: first.result.nextCursor },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "INVALID_CURSOR" },
    });
  });

  it("summarises a table too large for one page and names read_word_table", async () => {
    const { project, editor, ctx } = await toolFixture("word-chapter-table");
    await storeArtifact(
      project.id,
      editor,
      "wide.docx",
      await buildDocx({
        body: [
          { type: "heading", level: 1, text: "Inventory" },
          {
            type: "table",
            rows: Array.from({ length: 200 }, (_value, index) => [
              `Component number ${index + 1}`,
              "Owned by the platform team",
              "Reviewed every quarter",
            ]),
          },
        ],
      }),
    );

    const { result } = await call<Nested<WordChapter>>(
      "read_word_chapter",
      {
        projectId: project.id,
        filename: "wide.docx",
        chapterId: "chapter-001",
        includeTables: true,
      },
      ctx,
    );

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({
      type: "table",
      tableId: "table-001",
      rowCount: 200,
      columnCount: 3,
      omitted: true,
    });
    expect(result.blocks[0]!.values).toBeUndefined();
    expect(result.blocks[0]!.hint).toContain("read_word_table");
    expect(result.truncated).toBe(true);
    expect(result.nextCursor).toBeNull();
  });

  it("excludes template guidance unless includeInstructions is set", async () => {
    const { project, editor, ctx } = await toolFixture("word-chapter-guidance");
    await storeArtifact(
      project.id,
      editor,
      "template.docx",
      await buildDocx({
        body: [
          { type: "heading", level: 1, text: "Scope" },
          { type: "paragraph", text: "The scope covers two systems." },
          {
            type: "paragraph",
            style: "guidance",
            text: "Describe the scope in two sentences.",
          },
        ],
      }),
    );

    const input = {
      projectId: project.id,
      filename: "template.docx",
      chapterId: "chapter-001",
    };
    const plain = await call<Nested<WordChapter>>(
      "read_word_chapter",
      input,
      ctx,
    );
    expect(plain.result.blocks.map((block) => block.text)).toEqual([
      "The scope covers two systems.",
    ]);

    const withGuidance = await call<Nested<WordChapter>>(
      "read_word_chapter",
      { ...input, includeInstructions: true },
      ctx,
    );
    expect(withGuidance.result.blocks.map((block) => block.text)).toEqual([
      "The scope covers two systems.",
      "Describe the scope in two sentences.",
    ]);
    expect(withGuidance.result.blocks[1]!.kind).toBe("instruction");
  });

  it("separates an unknown chapter or table from a malformed id", async () => {
    const { project, editor, ctx } = await toolFixture("word-ids");
    await storeArtifact(
      project.id,
      editor,
      "plan.docx",
      await buildDocx({
        body: [
          { type: "heading", level: 1, text: "Only chapter" },
          { type: "table", rows: [["Item", "Owner"]] },
        ],
      }),
    );

    const base = { projectId: project.id, filename: "plan.docx" };
    await expect(
      execute("read_word_chapter", { ...base, chapterId: "chapter-999" }, ctx),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      execute("read_word_chapter", { ...base, chapterId: "chapter one" }, ctx),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      execute("read_word_table", { ...base, tableId: "table-999" }, ctx),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      execute("read_word_table", { ...base, tableId: "the big one" }, ctx),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("finds Word tables by query and requires at least one criterion", async () => {
    const { project, editor, ctx } = await toolFixture("word-find-tables");
    await storeArtifact(
      project.id,
      editor,
      "plan.docx",
      await buildDocx({
        body: [
          { type: "heading", level: 1, text: "Interfaces" },
          { type: "paragraph", text: "Table 1: Interface owners" },
          {
            type: "table",
            rows: [
              ["Interface", "Owner"],
              ["Ingest", "Ada"],
            ],
          },
          { type: "heading", level: 1, text: "Risks" },
          {
            type: "table",
            rows: [
              ["Risk", "Mitigation"],
              ["Outage", "Failover"],
            ],
          },
        ],
      }),
    );

    const { result } = await call<Nested<WordTableCandidates>>(
      "find_word_tables",
      {
        projectId: project.id,
        filename: "plan.docx",
        query: "interface owners",
      },
      ctx,
    );

    expect(result.candidates[0]).toMatchObject({
      tableId: "table-001",
      caption: "Table 1: Interface owners",
      chapterTitle: "Interfaces",
      rows: 2,
      columns: 2,
    });
    expect(result.candidates[0]!.headerRow).toEqual(["Interface", "Owner"]);
    expect(result.candidates[0]!.score).toBeGreaterThan(
      result.candidates[1]!.score,
    );

    await expect(
      execute(
        "find_word_tables",
        { projectId: project.id, filename: "plan.docx" },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        "find_word_tables needs at least one of query, captionNumber, expectedHeaders or chapterTitle",
    });
  });

  it("pages a long Word table with its header row on every page", async () => {
    const { project, editor, ctx } = await toolFixture("word-table-paging");
    await storeArtifact(
      project.id,
      editor,
      "rows.docx",
      await buildDocx({
        body: [
          { type: "heading", level: 1, text: "Components" },
          {
            type: "table",
            rows: [
              ["Component", "Owner", "Status"],
              ...Array.from({ length: 499 }, (_value, index) => [
                `Component number ${index + 1}`,
                "Platform team",
                "Reviewed",
              ]),
            ],
          },
        ],
      }),
    );

    let cursor: string | undefined;
    const rows: number[] = [];
    let calls = 0;
    do {
      const { result } = await call<Nested<WordTable>>(
        "read_word_table",
        {
          projectId: project.id,
          filename: "rows.docx",
          tableId: "table-001",
          ...(cursor === undefined ? {} : { cursor }),
        },
        ctx,
      );
      expect(result.rowCount).toBe(500);
      expect(result.header).toEqual(["Component", "Owner", "Status"]);
      expect(result.hasMore).toBe(result.nextCursor !== null);
      for (const row of result.rows) {
        expect(row.values[0]).toBe(`Component number ${row.row - 1}`);
        rows.push(row.row);
      }
      cursor = result.nextCursor ?? undefined;
      calls += 1;
    } while (cursor !== undefined && calls < 20);

    expect(calls).toBeGreaterThan(2);
    expect(cursor).toBeUndefined();
    expect(rows).toEqual(
      Array.from({ length: 499 }, (_value, index) => index + 2),
    );
  });

  it("returns a table's dropdown options when asked", async () => {
    const { project, editor, ctx } = await toolFixture("word-table-dropdown");
    await storeArtifact(
      project.id,
      editor,
      "form.docx",
      await buildDocx({
        body: [
          { type: "heading", level: 1, text: "Form" },
          {
            type: "table",
            rows: [
              ["Field", "Value"],
              [
                "Status",
                {
                  dropdown: {
                    id: "101",
                    type: "dropDownList",
                    selectedText: "Approved",
                    alias: "Status",
                    options: [
                      { value: "Approved" },
                      { value: "Rejected", displayText: "Rejected" },
                    ],
                  },
                },
              ],
            ],
          },
        ],
      }),
    );

    const plain = await call<Nested<WordTable>>(
      "read_word_table",
      { projectId: project.id, filename: "form.docx", tableId: "table-001" },
      ctx,
    );
    expect(plain.result.dropdowns).toBeUndefined();
    expect(plain.result.rows.map((row) => row.values)).toEqual([
      ["Status", "Approved"],
    ]);

    const { result } = await call<Nested<WordTable>>(
      "read_word_table",
      {
        projectId: project.id,
        filename: "form.docx",
        tableId: "table-001",
        includeDropdowns: true,
      },
      ctx,
    );
    expect(result.dropdowns).toHaveLength(1);
    expect(result.dropdowns![0]).toMatchObject({
      controlId: "101",
      selectedText: "Approved",
    });
    expect(result.dropdowns![0]!.options).toEqual([
      { value: "Approved", displayText: "Approved" },
      { value: "Rejected", displayText: "Rejected" },
    ]);
  });

  it("pages a long spreadsheet and reassembles every row exactly", async () => {
    const { project, editor, ctx } = await toolFixture("excel-sheet-paging");
    const ROWS = 5_000;
    await storeArtifact(
      project.id,
      editor,
      "big.xlsx",
      await buildXlsx([
        {
          name: "Ledger",
          rows: Array.from({ length: ROWS }, (_value, index) => [
            `r${index + 1}`,
            `v${index + 1}`,
          ]),
        },
      ]),
    );

    let cursor: string | undefined;
    const seen: string[] = [];
    let calls = 0;
    do {
      const { result } = await call<Nested<ExcelRows>>(
        "read_excel_sheet",
        {
          projectId: project.id,
          filename: "big.xlsx",
          sheetName: "Ledger",
          maxCells: 10_000,
          ...(cursor === undefined ? {} : { cursor }),
        },
        ctx,
      );
      expect(result.sheetName).toBe("Ledger");
      expect(result.hasMore).toBe(result.nextCursor !== null);
      for (const row of result.rows) {
        expect(row.values).toEqual([`r${row.row}`, `v${row.row}`]);
        seen.push(String(row.row));
      }
      cursor = result.nextCursor ?? undefined;
      calls += 1;
    } while (cursor !== undefined && calls < 40);

    expect(calls).toBeGreaterThan(2);
    expect(cursor).toBeUndefined();
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(
      Array.from({ length: ROWS }, (_value, index) => String(index + 1)),
    );
  });

  it("pages a whole workbook across its sheets", async () => {
    const { project, editor, ctx } = await toolFixture("excel-workbook-paging");
    const sheetNames = ["Alpha", "Beta", "Gamma"];
    await storeArtifact(
      project.id,
      editor,
      "book.xlsx",
      await buildXlsx(
        sheetNames.map((name) => ({
          name,
          rows: Array.from({ length: 40 }, (_value, index) => [
            `${name} row ${index + 1}`,
            "a".repeat(120),
            "b".repeat(120),
          ]),
        })),
      ),
    );

    let cursor: string | undefined;
    const seen: string[] = [];
    let calls = 0;
    do {
      const { result } = await call<Nested<ExcelRows>>(
        "read_excel_sheet",
        {
          projectId: project.id,
          filename: "book.xlsx",
          ...(cursor === undefined ? {} : { cursor }),
        },
        ctx,
      );
      expect(result.sheetName).toBeNull();
      expect(result.hasMore).toBe(result.nextCursor !== null);
      for (const row of result.rows) seen.push(`${row.sheet}#${row.row}`);
      cursor = result.nextCursor ?? undefined;
      calls += 1;
    } while (cursor !== undefined && calls < 40);

    expect(calls).toBeGreaterThan(2);
    expect(cursor).toBeUndefined();
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(
      sheetNames.flatMap((name) =>
        Array.from({ length: 40 }, (_value, index) => `${name}#${index + 1}`),
      ),
    );
  });

  it("reads a range window of one sheet", async () => {
    const { project, editor, ctx } = await toolFixture("excel-range");
    await storeArtifact(
      project.id,
      editor,
      "book.xlsx",
      await buildXlsx([
        {
          name: "People",
          rows: [
            ["Name", "Role", "Team"],
            ["Ada", "Engineer", "Platform"],
            ["Grace", "Architect", "Platform"],
            ["Alan", "Analyst", "Data"],
          ],
        },
      ]),
    );

    const { result } = await call<Nested<ExcelRows>>(
      "read_excel_sheet",
      {
        projectId: project.id,
        filename: "book.xlsx",
        sheetName: "People",
        range: "B2:C3",
      },
      ctx,
    );

    expect(result).toMatchObject({
      sheetName: "People",
      range: "B2:C3",
      startRow: 2,
      endRow: 3,
      nextCursor: null,
    });
    expect(result.rows).toEqual([
      { row: 2, values: ["Engineer", "Platform"] },
      { row: 3, values: ["Architect", "Platform"] },
    ]);
  });

  it("refuses a range without a sheet name", async () => {
    const { project, editor, ctx } = await toolFixture("excel-range-no-sheet");
    await storeArtifact(
      project.id,
      editor,
      "book.xlsx",
      await buildXlsx([{ name: "People", rows: [["Name"]] }]),
    );

    await expect(
      execute(
        "read_excel_sheet",
        { projectId: project.id, filename: "book.xlsx", range: "A1:B2" },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "range needs a sheetName; name the sheet you want to read",
    });
  });

  it("explains a sheet too wide for one page", async () => {
    const { project, editor, ctx } = await toolFixture("excel-too-wide");
    await storeArtifact(
      project.id,
      editor,
      "book.xlsx",
      await buildXlsx([{ name: "People", rows: [["Name", "Role", "Team"]] }]),
    );

    await expect(
      execute(
        "read_excel_sheet",
        { projectId: project.id, filename: "book.xlsx", maxCells: 1 },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining(
        "find the sheet's name with get_artifact_overview, then read it with sheetName and a range",
      ),
    });

    await expect(
      execute(
        "read_excel_sheet",
        {
          projectId: project.id,
          filename: "book.xlsx",
          sheetName: "People",
          maxCells: 1,
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("3 columns wide"),
    });
  });

  it("keeps a wide table readable by bounding its repeated header row", async () => {
    const { project, editor, ctx } = await toolFixture("word-table-wide-head");
    const headings = Array.from(
      { length: 63 },
      (_value, index) => `Column ${index + 1} ${"h".repeat(300)}`,
    );
    await storeArtifact(
      project.id,
      editor,
      "wide.docx",
      await buildDocx({
        body: [
          { type: "heading", level: 1, text: "Matrix" },
          {
            type: "table",
            rows: [
              headings,
              ...Array.from({ length: 40 }, (_value, row) =>
                Array.from(
                  { length: 63 },
                  (_cell, column) => `r${row}c${column}`,
                ),
              ),
            ],
          },
        ],
      }),
    );

    let cursor: string | undefined;
    const rows: number[] = [];
    let calls = 0;
    do {
      const { result } = await call<Nested<WordTable>>(
        "read_word_table",
        {
          projectId: project.id,
          filename: "wide.docx",
          tableId: "table-001",
          ...(cursor === undefined ? {} : { cursor }),
        },
        ctx,
      );
      expect(result.headerTruncated).toBe(true);
      expect(result.header!.length).toBeLessThan(63);
      expect(result.header![0]!.length).toBeLessThanOrEqual(120);
      // The point of the bound: every page still carries rows.
      expect(result.rows.length).toBeGreaterThan(0);
      for (const row of result.rows) rows.push(row.row);
      cursor = result.nextCursor ?? undefined;
      calls += 1;
    } while (cursor !== undefined && calls < 20);

    expect(calls).toBeGreaterThan(1);
    expect(cursor).toBeUndefined();
    expect(rows).toEqual(Array.from({ length: 40 }, (_value, i) => i + 2));
  });

  it("pages a chapter longer than one reader window through consecutive windows", async () => {
    const { project, editor, ctx } = await toolFixture("word-chapter-windows");
    // Tiny paragraphs: a page holds more than the reader's 200-block window,
    // so the first cursor comes from the reader's own continuation.
    await storeArtifact(
      project.id,
      editor,
      "windows.docx",
      await buildDocx({
        body: [
          { type: "heading", level: 1, text: "Windows" },
          ...Array.from({ length: 450 }, () => ({
            type: "paragraph" as const,
            text: "p",
          })),
        ],
      }),
    );

    const first = await call<Nested<WordChapter>>(
      "read_word_chapter",
      {
        projectId: project.id,
        filename: "windows.docx",
        chapterId: "chapter-001",
      },
      ctx,
    );
    expect(first.result.blockCount).toBe(450);
    expect(first.result.blocks).toHaveLength(200);
    expect(first.result.hasMore).toBe(true);

    const seen = first.result.blocks.map((block) => block.blockId);
    let cursor = first.result.nextCursor ?? undefined;
    let calls = 1;
    while (cursor !== undefined && calls < 10) {
      const { result } = await call<Nested<WordChapter>>(
        "read_word_chapter",
        {
          projectId: project.id,
          filename: "windows.docx",
          chapterId: "chapter-001",
          cursor,
        },
        ctx,
      );
      expect(result.blockCount).toBe(450);
      for (const block of result.blocks) seen.push(block.blockId);
      cursor = result.nextCursor ?? undefined;
      calls += 1;
    }
    expect(calls).toBe(3);
    expect(cursor).toBeUndefined();
    expect(seen).toEqual(
      Array.from(
        { length: 450 },
        (_value, index) => `p-${String(index + 2).padStart(3, "0")}`,
      ),
    );
  });

  it("pages a table longer than one reader window through consecutive windows", async () => {
    const { project, editor, ctx } = await toolFixture("word-table-windows");
    await storeArtifact(
      project.id,
      editor,
      "windows.docx",
      await buildDocx({
        body: [
          { type: "heading", level: 1, text: "Rows" },
          {
            type: "table",
            rows: [
              ["A", "B"],
              ...Array.from({ length: 500 }, () => ["a", "b"]),
            ],
          },
        ],
      }),
    );

    const first = await call<Nested<WordTable>>(
      "read_word_table",
      { projectId: project.id, filename: "windows.docx", tableId: "table-001" },
      ctx,
    );
    expect(first.result.rowCount).toBe(501);
    expect(first.result.columnCount).toBe(2);
    expect(first.result.header).toEqual(["A", "B"]);
    expect(first.result.rows).toHaveLength(200);
    expect(first.result.hasMore).toBe(true);

    const rows = first.result.rows.map((row) => row.row);
    let cursor = first.result.nextCursor ?? undefined;
    let calls = 1;
    while (cursor !== undefined && calls < 10) {
      const { result } = await call<Nested<WordTable>>(
        "read_word_table",
        {
          projectId: project.id,
          filename: "windows.docx",
          tableId: "table-001",
          cursor,
        },
        ctx,
      );
      expect(result.rowCount).toBe(501);
      expect(result.header).toEqual(["A", "B"]);
      for (const row of result.rows) rows.push(row.row);
      cursor = result.nextCursor ?? undefined;
      calls += 1;
    }
    expect(calls).toBe(3);
    expect(cursor).toBeUndefined();
    expect(rows).toEqual(Array.from({ length: 500 }, (_value, i) => i + 2));
  });

  it("pages a chapter whose title alone would fill a page", async () => {
    const { project, editor, ctx } = await toolFixture(
      "word-chapter-long-title",
    );
    await storeArtifact(
      project.id,
      editor,
      "titled.docx",
      await buildDocx({
        body: [
          { type: "heading", level: 1, text: "T".repeat(20_000) },
          ...Array.from({ length: 200 }, (_value, index) => ({
            type: "paragraph" as const,
            text: `Paragraph ${index + 1} of a chapter with an enormous title.`,
          })),
        ],
      }),
    );

    let cursor: string | undefined;
    const seen: string[] = [];
    let calls = 0;
    do {
      const { result } = await call<Nested<WordChapter>>(
        "read_word_chapter",
        {
          projectId: project.id,
          filename: "titled.docx",
          chapterId: "chapter-001",
          ...(cursor === undefined ? {} : { cursor }),
        },
        ctx,
      );
      expect(result.title.length).toBeLessThanOrEqual(500);
      expect(result.blocks.length).toBeGreaterThan(0);
      for (const block of result.blocks) seen.push(block.blockId);
      cursor = result.nextCursor ?? undefined;
      calls += 1;
    } while (cursor !== undefined && calls < 20);

    expect(cursor).toBeUndefined();
    expect(seen).toHaveLength(200);
  });

  it("reads an empty and a header-only table without inventing a header", async () => {
    const { project, editor, ctx } = await toolFixture("word-table-empty");
    await storeArtifact(
      project.id,
      editor,
      "thin.docx",
      await buildDocx({
        body: [
          { type: "heading", level: 1, text: "Tables" },
          { type: "table", rows: [] },
          { type: "table", rows: [["Name", "Role"]] },
        ],
      }),
    );

    const empty = await call<Nested<WordTable>>(
      "read_word_table",
      { projectId: project.id, filename: "thin.docx", tableId: "table-001" },
      ctx,
    );
    expect(empty.result).toMatchObject({
      rowCount: 0,
      columnCount: 0,
      header: null,
      headerTruncated: false,
      startRow: null,
      truncated: false,
      hasMore: false,
      nextCursor: null,
    });
    expect(empty.result.rows).toEqual([]);

    const headerOnly = await call<Nested<WordTable>>(
      "read_word_table",
      { projectId: project.id, filename: "thin.docx", tableId: "table-002" },
      ctx,
    );
    expect(headerOnly.result).toMatchObject({
      rowCount: 1,
      header: ["Name", "Role"],
      startRow: null,
      nextCursor: null,
    });
    expect(headerOnly.result.rows).toEqual([]);
  });

  it("rejects a continuation whose query no longer matches the cursor", async () => {
    const { project, editor, ctx } = await toolFixture("paged-query-drift");
    await storeArtifact(
      project.id,
      editor,
      "long.docx",
      await buildDocx({
        body: [
          { type: "heading", level: 1, text: "Findings" },
          ...Array.from({ length: 400 }, (_value, index) => ({
            type: "paragraph" as const,
            text: `Paragraph ${index + 1} of the findings chapter.`,
          })),
          {
            type: "table",
            rows: Array.from({ length: 400 }, (_value, index) => [
              `Component number ${index + 1}`,
              "Platform team",
            ]),
          },
        ],
      }),
    );
    await storeArtifact(
      project.id,
      editor,
      "big.xlsx",
      await buildXlsx([
        {
          name: "Ledger",
          rows: Array.from({ length: 800 }, (_value, index) => [
            `r${index + 1}`,
            "a".repeat(60),
          ]),
        },
      ]),
    );

    const chapter = await call<Nested<WordChapter>>(
      "read_word_chapter",
      {
        projectId: project.id,
        filename: "long.docx",
        chapterId: "chapter-001",
      },
      ctx,
    );
    const table = await call<Nested<WordTable>>(
      "read_word_table",
      { projectId: project.id, filename: "long.docx", tableId: "table-001" },
      ctx,
    );
    const sheet = await call<Nested<ExcelRows>>(
      "read_excel_sheet",
      { projectId: project.id, filename: "big.xlsx", sheetName: "Ledger" },
      ctx,
    );
    const workbook = await call<Nested<ExcelRows>>(
      "read_excel_sheet",
      { projectId: project.id, filename: "big.xlsx" },
      ctx,
    );

    const drifted = [
      [
        "read_word_chapter",
        {
          filename: "long.docx",
          chapterId: "chapter-001",
          includeTables: true,
          cursor: chapter.result.nextCursor,
        },
      ],
      [
        "read_word_table",
        {
          filename: "long.docx",
          tableId: "table-001",
          includeDropdowns: true,
          cursor: table.result.nextCursor,
        },
      ],
      [
        "read_excel_sheet",
        {
          filename: "big.xlsx",
          sheetName: "Ledger",
          maxCells: 250,
          cursor: sheet.result.nextCursor,
        },
      ],
      [
        "read_excel_sheet",
        {
          filename: "big.xlsx",
          sheetName: "Ledger",
          cursor: workbook.result.nextCursor,
        },
      ],
    ] as const;
    for (const [name, input] of drifted)
      await expect(
        execute(name, { projectId: project.id, ...input }, ctx),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        details: { reason: "INVALID_CURSOR" },
      });
  });

  it("rejects every paged file cursor once the file was replaced", async () => {
    const { project, editor, ctx } = await toolFixture("paged-stale");
    const docx = await buildDocx({
      body: [
        { type: "heading", level: 1, text: "Findings" },
        ...Array.from({ length: 400 }, (_value, index) => ({
          type: "paragraph" as const,
          text: `Paragraph ${index + 1} of the findings chapter.`,
        })),
        {
          type: "table",
          rows: Array.from({ length: 400 }, (_value, index) => [
            `Component number ${index + 1}`,
            "Platform team",
          ]),
        },
      ],
    });
    await storeArtifact(project.id, editor, "long.docx", docx);
    await storeArtifact(
      project.id,
      editor,
      "big.xlsx",
      await buildXlsx([
        {
          name: "Ledger",
          rows: Array.from({ length: 800 }, (_value, index) => [
            `r${index + 1}`,
            "a".repeat(60),
          ]),
        },
      ]),
    );

    const chapter = await call<Nested<WordChapter>>(
      "read_word_chapter",
      {
        projectId: project.id,
        filename: "long.docx",
        chapterId: "chapter-001",
      },
      ctx,
    );
    const table = await call<Nested<WordTable>>(
      "read_word_table",
      {
        projectId: project.id,
        filename: "long.docx",
        tableId: "table-001",
      },
      ctx,
    );
    const sheet = await call<Nested<ExcelRows>>(
      "read_excel_sheet",
      { projectId: project.id, filename: "big.xlsx", sheetName: "Ledger" },
      ctx,
    );
    const workbook = await call<Nested<ExcelRows>>(
      "read_excel_sheet",
      { projectId: project.id, filename: "big.xlsx" },
      ctx,
    );
    for (const cursor of [
      chapter.result.nextCursor,
      table.result.nextCursor,
      sheet.result.nextCursor,
      workbook.result.nextCursor,
    ])
      expect(cursor).not.toBeNull();

    await replaceArtifact(
      project.id,
      editor,
      "long.docx",
      await buildDocx({
        body: [{ type: "heading", level: 1, text: "Findings" }],
      }),
    );
    await replaceArtifact(
      project.id,
      editor,
      "big.xlsx",
      await buildXlsx([{ name: "Ledger", rows: [["r1", "v1"]] }]),
    );

    const stale = [
      [
        "read_word_chapter",
        {
          filename: "long.docx",
          chapterId: "chapter-001",
          cursor: chapter.result.nextCursor,
        },
      ],
      [
        "read_word_table",
        {
          filename: "long.docx",
          tableId: "table-001",
          cursor: table.result.nextCursor,
        },
      ],
      [
        "read_excel_sheet",
        {
          filename: "big.xlsx",
          sheetName: "Ledger",
          cursor: sheet.result.nextCursor,
        },
      ],
      [
        "read_excel_sheet",
        { filename: "big.xlsx", cursor: workbook.result.nextCursor },
      ],
    ] as const;
    for (const [name, input] of stale)
      await expect(
        execute(name, { projectId: project.id, ...input }, ctx),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        details: { reason: "STALE_BASE" },
      });
  });

  it("refuses a project outside the conversation scope before any database read", async () => {
    const { ctx } = await toolFixture("scope");
    const outside = randomUUID();
    for (const [name, input] of TOOL_INPUTS)
      await expect(
        execute(name, { projectId: outside, ...input }, ctx),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        details: { reason: "SCOPE_VIOLATION" },
      });
  });

  it("hides a scoped project the caller is not a member of", async () => {
    const { db, project, editor, outsider, scope } =
      await toolFixture("outsider");
    await storeArtifact(project.id, editor, "data.json", '{"a":1}');
    const ctx: ToolContext = {
      db,
      actor: outsider,
      scope,
      profile: { name: "Outsider", email: "outsider@example.test" },
      run: null,
    };

    for (const [name, input] of TOOL_INPUTS)
      await expect(
        execute(name, { projectId: project.id, ...input }, ctx),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("text CSV YAML and structure tools", () => {
  beforeEach(resetDb);

  it("all_new_contracts_share_assistant_and_mcp_registry", () => {
    for (const name of [
      "read_text_artifact",
      "read_csv_artifact",
      "inspect_structured_artifact",
    ]) {
      const tool = toolByName(name);
      expect(tool).toBeDefined();
      expect(ASSISTANT_TOOLS).toContain(tool);
      expect(MCP_TOOLS).toContain(tool);
      expect(tool).toMatchObject({ kind: "read", capability: "content:read" });
    }
  });

  it("old_octet_stream_yaml_upload_reads_without_reupload", async () => {
    const { project, editor, ctx, db } = await toolFixture("old-yaml");
    const { artifact } = await storeArtifact(
      project.id,
      editor,
      "old.YML",
      "items:\n  - name: first\n",
    );
    await db.artifact.update({
      where: { id: artifact.id },
      data: { contentType: "application/octet-stream" },
    });
    const target = { projectId: project.id, filename: "old.YML" };
    const listed = await call<{ items: { readable: boolean }[] }>(
      "search_artifacts",
      { projectId: project.id },
      ctx,
    );
    expect(listed.items[0]?.readable).toBe(true);
    const overview = await call<Nested<{ format: string }>>(
      "get_artifact_overview",
      target,
      ctx,
    );
    expect(overview.result.format).toBe("yaml");
    const queried = await call<Nested<{ items: unknown[] }>>(
      "query_json_artifact",
      { ...target, path: "$.items[*]" },
      ctx,
    );
    expect(queried.result.items).toEqual([{ name: "first" }]);
  });

  it("complete_outputs_fit_16000_bytes_with_unicode_and_cursor and long_line_tool_pages_reconstruct_selected_range", async () => {
    const { project, editor, ctx } = await toolFixture("text-pages");
    const selected = '界😀\"\t'.repeat(5000) + "\r\nlast selected\r";
    await storeArtifact(
      project.id,
      editor,
      "lines.txt",
      "excluded\n" + selected + "excluded tail",
    );
    const target = {
      projectId: project.id,
      filename: "lines.txt",
      startLine: 2,
      endLine: 3,
    };
    let cursor: string | undefined;
    let reconstructed = "";
    for (let i = 0; i < 30; i++) {
      const page = await call<
        Nested<{ text: string; nextCursor: string | null; lineCount: number }>
      >(
        "read_text_artifact",
        {
          ...target,
          startLine: i % 2 ? undefined : target.startLine,
          cursor,
          limit: i % 2 ? 1 : 100,
        },
        ctx,
      );
      expect(page.result.text.length).toBeGreaterThan(0);
      expect(page.result.lineCount).toBeLessThanOrEqual(2);
      reconstructed += page.result.text;
      if (!page.result.nextCursor) break;
      expect(page.result.nextCursor).not.toBe(cursor);
      cursor = page.result.nextCursor;
    }
    expect(reconstructed).toBe(selected);
    const found = await call<Nested<{ matches: { line: number }[] }>>(
      "search_artifact_text",
      { ...target, query: "last selected" },
      ctx,
    );
    expect(found.result.matches[0]?.line).toBe(3);
  });

  it("later_structure_keys_and_csv_columns_are_reachable", async () => {
    const { project, editor, ctx } = await toolFixture("wide-pages");
    const names = Array.from(
      { length: 240 },
      (_, i) => `key-${String(i).padStart(3, "0")}-${"界".repeat(100)}`,
    );
    await storeArtifact(
      project.id,
      editor,
      "wide.json",
      JSON.stringify(Object.fromEntries(names.map((name) => [name, 1]))),
    );
    await storeArtifact(
      project.id,
      editor,
      "wide.csv",
      names.join(",") + "\n" + names.map((_, i) => String(i)).join(","),
    );
    for (const [tool, filename, list, key] of [
      ["inspect_structured_artifact", "wide.json", "nodes", "pointer"],
      ["get_artifact_overview", "wide.csv", "columns", "index"],
    ]) {
      let cursor: string | undefined;
      const seen: unknown[] = [];
      for (let i = 0; i < 40; i++) {
        const page = await call<Nested<Record<string, unknown>>>(
          tool!,
          { projectId: project.id, filename, cursor },
          ctx,
        );
        seen.push(
          ...(page.result[list!] as Record<string, unknown>[]).map(
            (item) => item[key!],
          ),
        );
        if (!page.result.nextCursor) break;
        cursor = page.result.nextCursor as string;
      }
      expect(seen).toContain(filename === "wide.csv" ? 239 : `/${names[239]}`);
    }
    const rows = await call<
      Nested<{
        rows: {
          cells: { index: number; value: string }[];
          omittedCellCount: number;
        }[];
      }>
    >(
      "read_csv_artifact",
      { projectId: project.id, filename: "wide.csv", columns: [239] },
      ctx,
    );
    expect(rows.result.rows[0]?.cells).toEqual([
      { index: 239, value: "239", truncated: false },
    ]);
    expect(rows.result.rows[0]?.omittedCellCount).toBe(239);
  });

  it("wrong_query_or_replaced_file_rejects_cursor", async () => {
    const { project, editor, ctx } = await toolFixture("new-cursors");
    await storeArtifact(project.id, editor, "range.txt", "one\ntwo\nthree");
    const target = { projectId: project.id, filename: "range.txt" };
    const page = await call<Nested<{ nextCursor: string }>>(
      "read_text_artifact",
      { ...target, limit: 1 },
      ctx,
    );
    expect(page.result.nextCursor).toBeTruthy();
    await expect(
      execute(
        "read_text_artifact",
        { ...target, cursor: page.result.nextCursor, startLine: 2 },
        ctx,
      ),
    ).rejects.toMatchObject({ details: { reason: "INVALID_CURSOR" } });
    await expect(
      execute(
        "read_text_artifact",
        { ...target, cursor: page.result.nextCursor, endLine: 2 },
        ctx,
      ),
    ).rejects.toMatchObject({ details: { reason: "INVALID_CURSOR" } });
    await replaceArtifact(project.id, editor, "range.txt", "changed");
    await expect(
      execute(
        "read_text_artifact",
        { ...target, cursor: page.result.nextCursor },
        ctx,
      ),
    ).rejects.toMatchObject({ details: { reason: "STALE_BASE" } });
  });

  it("unauthorized_or_aborted_read_never_returns_content", async () => {
    const { project, editor, outsider, ctx } = await toolFixture("new-gates");
    await storeArtifact(project.id, editor, "private.txt", "secret");
    const target = { projectId: project.id, filename: "private.txt" };
    await expect(
      execute("read_text_artifact", target, { ...ctx, actor: outsider }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      execute("read_text_artifact", target, {
        ...ctx,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
  });

  it("CSV oversized rows advance and adjustable cursors reject repeated conflicting row starts", async () => {
    const { project, editor, ctx } = await toolFixture("csv-cursors");
    await storeArtifact(
      project.id,
      editor,
      "big.csv",
      'a,a,,tail\n"' + "界".repeat(9000) + '",b,,d\n2,3,4,5',
    );
    const target = { projectId: project.id, filename: "big.csv" };
    const first = await call<
      Nested<{
        rows: {
          row: number;
          cells: { value: string; truncated: boolean }[];
          omittedCellCount: number;
        }[];
        nextCursor: string;
        nextRow: number;
      }>
    >("read_csv_artifact", { ...target, limit: 1 }, ctx);
    expect(first.result.rows[0]?.cells[0]?.truncated).toBe(true);
    expect(first.result.nextRow).toBe(2);
    await expect(
      execute(
        "read_csv_artifact",
        { ...target, cursor: first.result.nextCursor, startRow: 1 },
        ctx,
      ),
    ).rejects.toMatchObject({ details: { reason: "INVALID_CURSOR" } });
    const second = await call<
      Nested<{ rows: { row: number }[]; nextCursor: null }>
    >(
      "read_csv_artifact",
      { ...target, cursor: first.result.nextCursor, startRow: 2, limit: 200 },
      ctx,
    );
    expect(second.result.rows.map((row) => row.row)).toEqual([2]);
    expect(second.result.nextCursor).toBeNull();
    await expect(
      execute(
        "read_csv_artifact",
        { ...target, cursor: first.result.nextCursor, columns: [1] },
        ctx,
      ),
    ).rejects.toMatchObject({ details: { reason: "INVALID_CURSOR" } });
  });

  it("search pages keep unsent suffix matches across long text and CSV fields", async () => {
    const { project, editor, ctx } = await toolFixture("search-pages");
    const source = ("界".repeat(180) + "NEEDLE").repeat(90);
    for (const filename of ["search.txt", "search.csv"]) {
      await storeArtifact(
        project.id,
        editor,
        filename,
        filename.endsWith("csv") ? "header\n" + source : source,
      );
      let cursor: string | undefined;
      const positions: number[] = [];
      for (let i = 0; i < 10; i++) {
        const page = await call<
          Nested<{
            matches: { charOffset: number }[];
            nextCursor: string | null;
          }>
        >(
          "search_artifact_text",
          {
            projectId: project.id,
            filename,
            query: "needle",
            cursor,
            limit: i % 2 ? 25 : 100,
          },
          ctx,
        );
        positions.push(...page.result.matches.map((match) => match.charOffset));
        if (!page.result.nextCursor) break;
        cursor = page.result.nextCursor;
      }
      expect(positions).toEqual(
        Array.from({ length: 90 }, (_, i) => i * 186 + 180),
      );
    }
  });

  it("structure preserves exact addresses or returns bounded actionable recovery", async () => {
    const { project, editor, ctx } = await toolFixture("structure-address");
    const filename = "界".repeat(250) + ".json";
    const key = "k".repeat(4060);
    await storeArtifact(
      project.id,
      editor,
      filename,
      JSON.stringify({ [key]: 1 }),
    );
    const target = { projectId: project.id, filename };
    await expect(
      execute(
        "inspect_structured_artifact",
        { ...target, pointer: "/" + key },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("shorter ancestor pointer"),
    });
    const root = await call<Nested<{ nodes: { pointer: string }[] }>>(
      "inspect_structured_artifact",
      { ...target, depth: 0 },
      ctx,
    );
    expect(root.result.nodes.map((node) => node.pointer)).toEqual([""]);
  });

  it("structure query paths longer than 500 characters remain usable with byte-bounded inputs", async () => {
    const { project, editor, ctx } = await toolFixture("long-query");
    const key = "界".repeat(300);
    await storeArtifact(
      project.id,
      editor,
      "long.json",
      JSON.stringify({ [key]: { value: 42 } }),
    );
    const target = { projectId: project.id, filename: "long.json" };
    const shape = await call<
      Nested<{ nodes: { queryPath: string; pointer: string }[] }>
    >("inspect_structured_artifact", target, ctx);
    const path = shape.result.nodes.find((node) =>
      node.pointer.endsWith("/value"),
    )!.queryPath;
    const longerKey = "k".repeat(700);
    await storeArtifact(
      project.id,
      editor,
      "longer.json",
      JSON.stringify({ [longerKey]: "界".repeat(8000) }),
    );
    const longerTarget = { ...target, filename: "longer.json" };
    const longerShape = await call<Nested<{ nodes: { queryPath: string }[] }>>(
      "inspect_structured_artifact",
      longerTarget,
      ctx,
    );
    const longerPath = longerShape.result.nodes[1]!.queryPath;
    expect(longerPath.length).toBeGreaterThan(500);
    const queried = await call<Nested<{ items: unknown[] }>>(
      "query_json_artifact",
      { ...target, path },
      ctx,
    );
    expect(queried.result.items).toEqual([42]);
    const clamped = await call<Nested<{ items: { truncatedJson: string }[] }>>(
      "query_json_artifact",
      { ...longerTarget, path: longerPath },
      ctx,
    );
    expect(clamped.result.items[0]?.truncatedJson).toBeDefined();
    expect(
      toolByName("query_json_artifact")!.inputSchema.safeParse({
        ...target,
        path: '$["' + "界".repeat(3000) + '"]',
      }).success,
    ).toBe(false);
  });

  it.each([{ startLine: 999 }, { endLine: 2 }])(
    "rejects explicit line selectors with a Markdown section: %j",
    async (range) => {
      const { project, editor, ctx } = await toolFixture("section-conflict");
      await storeArtifact(
        project.id,
        editor,
        "conflict.md",
        "# First\nselected\n# Second\nexcluded",
      );
      await expect(
        execute(
          "read_text_artifact",
          {
            projectId: project.id,
            filename: "conflict.md",
            sectionId: "heading-1",
            ...range,
          },
          ctx,
        ),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("cannot be combined"),
      });
    },
  );

  it("continues section-only reads without forwarding a synthesized line start", async () => {
    const { project, editor, ctx } = await toolFixture("section-cursor");
    const selected = "# First\nselected\nmore\n";
    await storeArtifact(
      project.id,
      editor,
      "sections.md",
      selected + "# Second\nexcluded",
    );
    const target = {
      projectId: project.id,
      filename: "sections.md",
      sectionId: "heading-1",
    };
    const first = await call<Nested<{ text: string; nextCursor: string }>>(
      "read_text_artifact",
      { ...target, limit: 1 },
      ctx,
    );
    expect(first.result.text).toBe("# First\n");
    expect(first.result.nextCursor).toEqual(expect.any(String));
    const last = await call<Nested<{ text: string; nextCursor: null }>>(
      "read_text_artifact",
      { ...target, cursor: first.result.nextCursor, limit: 2 },
      ctx,
    );
    expect(first.result.text + last.result.text).toBe(selected);
    expect(last.result.nextCursor).toBeNull();
  });

  it("Markdown block outline selects exact original container sections through the gateway", async () => {
    const { project, editor, ctx } = await toolFixture(
      "markdown-block-outline",
    );
    const lines = [
      "- ```md",
      "  # fake",
      "  ```",
      "",
      "<!--",
      "# fake",
      "-->",
      "",
      "> ## Same",
      "> body",
      "",
      "- Same",
      "  ---",
      "  selected",
      "",
      "## Same",
      "excluded",
    ];
    const source = lines.join("\r\n");
    await storeArtifact(project.id, editor, "blocks.md", source);
    const target = { projectId: project.id, filename: "blocks.md" };
    const overview = await call<
      Nested<{ headings: { id: string; title: string }[] }>
    >("get_artifact_overview", target, ctx);
    expect(
      overview.result.headings.map(({ id, title }) => ({ id, title })),
    ).toEqual([
      { id: "heading-9", title: "Same" },
      { id: "heading-12", title: "Same" },
      { id: "heading-16", title: "Same" },
    ]);
    const selected = await call<Nested<{ text: string }>>(
      "read_text_artifact",
      { ...target, sectionId: overview.result.headings[1]!.id },
      ctx,
    );
    expect(selected.result.text).toBe(
      lines.slice(11, 15).join("\r\n") + "\r\n",
    );
  });

  it("Markdown section mode is derived from the validated artifact format", async () => {
    const { project, editor, viewer, ctx } = await toolFixture("markdown-mode");
    const source = "# First\nselected\n# Second\nexcluded";
    await storeArtifact(project.id, editor, "sections.md", source);
    await storeArtifact(project.id, editor, "sections.txt", source);
    const target = { projectId: project.id, filename: "sections.md" };
    const overview = await call<Nested<{ headings: { id: string }[] }>>(
      "get_artifact_overview",
      target,
      ctx,
    );
    const selected = await call<Nested<{ text: string }>>(
      "read_text_artifact",
      { ...target, sectionId: overview.result.headings[0]!.id },
      ctx,
    );
    expect(selected.result.text).toBe("# First\nselected\n");
    await expect(
      readArtifact(
        getPrisma(),
        viewer,
        { ...target, filename: "sections.txt" },
        "text.read",
        { sectionId: "heading-1", markdown: true },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects escaped query headers that cannot fit a complete output", async () => {
    const { project, editor, ctx } = await toolFixture("escaped-query");
    const key = "\u0001".repeat(2500);
    await storeArtifact(
      project.id,
      editor,
      "escaped.json",
      JSON.stringify({ [key]: 42 }),
    );
    await expect(
      execute(
        "query_json_artifact",
        {
          projectId: project.id,
          filename: "escaped.json",
          path: '$["' + key + '"]',
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("shorter path"),
    });
  });

  it("keeps DOTX extraction and rejects unsupported native paging options", async () => {
    const { project, editor, ctx } = await toolFixture("dotx-regression");
    await storeArtifact(
      project.id,
      editor,
      "template.dotx",
      await buildDocx({
        body: [
          { type: "heading", level: 1, text: "Template" },
          { type: "paragraph", text: "Original content" },
        ],
      }),
    );
    const target = { projectId: project.id, filename: "template.dotx" };
    const outline = await call<
      Nested<{ format: string; chapters: { chapterId: string }[] }>
    >("get_artifact_overview", target, ctx);
    expect(outline.result.format).toBe("word");
    const chapter = await call<Nested<unknown>>(
      "read_word_chapter",
      { ...target, chapterId: outline.result.chapters[0]!.chapterId },
      ctx,
    );
    expect(JSON.stringify(chapter)).toContain("Original content");
    await expect(
      execute("get_artifact_overview", { ...target, hasHeader: false }, ctx),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("CSV"),
    });
    await expect(
      execute(
        "search_artifact_text",
        { ...target, query: "content", cursor: "unusable" },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Native search"),
    });
  });

  it("all extensions and sanitized malformed readers preserve raw YAML recovery", async () => {
    const { project, editor, ctx } = await toolFixture("extensions");
    for (const filename of ["a.txt", "a.md", "a.csv", "a.yaml", "a.yml"]) {
      await storeArtifact(project.id, editor, filename, "a: 1");
      const output = await call<Nested<{ text: string }>>(
        "read_text_artifact",
        { projectId: project.id, filename },
        ctx,
      );
      expect(output.result.text).toBe("a: 1");
    }
    await storeArtifact(
      project.id,
      editor,
      "bad.yaml",
      "secret: !secret private",
    );
    const target = { projectId: project.id, filename: "bad.yaml" };
    await expect(
      execute("inspect_structured_artifact", target, ctx),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const raw = await call<Nested<{ text: string }>>(
      "read_text_artifact",
      target,
      ctx,
    );
    expect(raw.result.text).toBe("secret: !secret private");
  });
});
