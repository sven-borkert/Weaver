import { describe, expect, it } from "vitest";
import { ArtifactReadError } from "./errors";
import {
  classifyPdfReadError,
  readPdfPages,
  readPdfSummary,
  searchPdfText,
} from "./pdf";
import { buildTestPdf } from "./testing/pdfFixture";

/**
 * A single unwrapped Tj line runs off the fixture's page edge (horizontally)
 * and pdf.js stops extracting past it; the same happens vertically once Td
 * moves below the MediaBox. `height` lets a test push well past both real
 * PDFs' clamp thresholds (1,000-100,000 chars / 1-100 search matches)
 * without hitting that fixture artifact.
 */
function buildMultiLinePdf(
  lineCount: number,
  opts: { height?: number; lineText?: (i: number) => string } = {},
): Buffer {
  const height = opts.height ?? 792;
  const lineText =
    opts.lineText ??
    ((i: number) => `Line number ${i} has some words in it to fill space`);
  let stream = `BT /F1 12 Tf 72 ${height - 72} Td\n`;
  for (let i = 0; i < lineCount; i++) {
    stream += `(${lineText(i)}) Tj\n0 -14 Td\n`;
  }
  stream += "ET";
  const objBodies = new Map<number, string>();
  objBodies.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objBodies.set(2, "<< /Type /Pages /Kids [4 0 R] /Count 1 >>");
  objBodies.set(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objBodies.set(
    4,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>`,
  );
  objBodies.set(
    5,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  );
  let out = "%PDF-1.4\n";
  const offsets = new Map<number, number>();
  for (let n = 1; n <= 5; n++) {
    offsets.set(n, out.length);
    out += `${n} 0 obj\n${objBodies.get(n)}\nendobj\n`;
  }
  const xrefOffset = out.length;
  out += `xref\n0 6\n0000000000 65535 f \n`;
  for (let n = 1; n <= 5; n++) {
    out += `${String(offsets.get(n)).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

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

describe("readPdfSummary", () => {
  it("reports page count, per-page char counts, info keys, and no warnings for text PDFs", async () => {
    const pdf = buildTestPdf([
      "Hello PDF page one",
      "Second page mentions Sword blade",
    ]);
    const bytes = new Uint8Array(pdf);
    const before = bytes.slice();
    const summary = await readPdfSummary(bytes);
    expect(summary.pageCount).toBe(2);
    expect(summary.pages).toEqual([
      { page: 1, chars: "Hello PDF page one".length },
      { page: 2, chars: "Second page mentions Sword blade".length },
    ]);
    expect(summary.totalChars).toBeGreaterThan(0);
    expect(summary.warnings).toEqual([]);
    expect(summary.info).toBeTypeOf("object");
    // Guards the copy-before-call rule: the caller's own bytes must survive untouched.
    expect(bytes).toEqual(before);
  });

  it("reports totalChars: 0 with a scanned-pages warning when pages have no text", async () => {
    const pdf = buildTestPdf(["", ""]);
    const summary = await readPdfSummary(new Uint8Array(pdf));
    expect(summary.totalChars).toBe(0);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toMatch(/scanned|OCR/i);
  });

  it("throws malformed for garbage bytes without leaking a marker from the input", async () => {
    const bytes = new TextEncoder().encode(
      "not a pdf at all MARKER_SECRET_XYZ",
    );
    const code = await readCode(readPdfSummary(bytes));
    expect(code).toBe("malformed");
    try {
      await readPdfSummary(bytes);
      expect.unreachable();
    } catch (e) {
      expect((e as ArtifactReadError).message).not.toContain(
        "MARKER_SECRET_XYZ",
      );
    }
  });
});

describe("readPdfPages", () => {
  it("returns the requested range and honors the char budget", async () => {
    const pdf = buildTestPdf([
      "Hello PDF page one",
      "Second page mentions Sword blade",
    ]);
    const bytes = new Uint8Array(pdf);
    const before = bytes.slice();
    const result = await readPdfPages(bytes, { startPage: 2 });
    expect(result.pageCount).toBe(2);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.page).toBe(2);
    expect(result.pages[0]!.text).toContain("Sword");
    expect(result.truncated).toBe(false);
    expect(bytes).toEqual(before);
  });

  it("truncates when the char budget cuts off mid-page and reports the last returned page", async () => {
    const pdf = buildMultiLinePdf(30); // ~1,489 chars, past the 1,000-char maxChars floor
    const result = await readPdfPages(new Uint8Array(pdf), {
      maxChars: 1_000,
    });
    expect(result.truncated).toBe(true);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.page).toBe(1);
    expect(result.pages[0]!.text).toHaveLength(1_000);
    expect(result.endPage).toBe(1);
  });

  it("clamps maxChars to the 100,000 ceiling even when the document has more text and a larger maxChars is requested", async () => {
    // Tall MediaBox avoids the fixture's page-edge extraction cutoff; ~108,000 chars total.
    const pdf = buildMultiLinePdf(2_100, { height: 2_000_000 });
    const bytes = new Uint8Array(pdf);
    const before = bytes.slice();
    const result = await readPdfPages(bytes, { maxChars: 500_000 });
    expect(result.truncated).toBe(true);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.text).toHaveLength(100_000);
    expect(bytes).toEqual(before);
  });

  it("clamps maxChars up to the 1,000 floor when a smaller value is requested", async () => {
    const pdf = buildTestPdf(["short text"]);
    const tooSmall = await readPdfPages(new Uint8Array(pdf), { maxChars: 1 });
    expect(tooSmall.truncated).toBe(false); // "short text" fits comfortably under the 1,000 floor
  });

  it("throws not_found when startPage is beyond the last page", async () => {
    const pdf = buildTestPdf(["only page"]);
    const code = await readCode(
      readPdfPages(new Uint8Array(pdf), { startPage: 3 }),
    );
    expect(code).toBe("not_found");
  });

  it("throws invalid_input when endPage is smaller than startPage", async () => {
    const pdf = buildTestPdf(["a", "b", "c"]);
    const code = await readCode(
      readPdfPages(new Uint8Array(pdf), { startPage: 3, endPage: 1 }),
    );
    expect(code).toBe("invalid_input");
  });

  it("defaults to the full page range with no input", async () => {
    const pdf = buildTestPdf(["a", "b"]);
    const result = await readPdfPages(new Uint8Array(pdf));
    expect(result.startPage).toBe(1);
    expect(result.endPage).toBe(2);
    expect(result.pages).toHaveLength(2);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "throws invalid_input for startPage %s",
    async (startPage) => {
      const pdf = buildTestPdf(["a", "b"]);
      const code = await readCode(
        readPdfPages(new Uint8Array(pdf), { startPage }),
      );
      expect(code).toBe("invalid_input");
    },
  );

  it.each([0, -1, 2.5, Number.NaN])(
    "throws invalid_input for endPage %s",
    async (endPage) => {
      const pdf = buildTestPdf(["a", "b"]);
      const code = await readCode(
        readPdfPages(new Uint8Array(pdf), { endPage }),
      );
      expect(code).toBe("invalid_input");
    },
  );

  it("treats a NaN maxChars as the default rather than an empty budget", async () => {
    const pdf = buildTestPdf(["only page"]);
    const result = await readPdfPages(new Uint8Array(pdf), {
      maxChars: Number.NaN,
    });
    expect(result.truncated).toBe(false);
    expect(result.pages[0]!.text).toContain("only page");
  });
});

describe("searchPdfText", () => {
  it("finds matches case-insensitively with page numbers", async () => {
    const pdf = buildTestPdf([
      "Hello PDF page one",
      "Second page mentions Sword blade",
    ]);
    const bytes = new Uint8Array(pdf);
    const before = bytes.slice();
    const found = await searchPdfText(bytes, { query: "sword" });
    expect(found.total).toBe(1);
    expect(found.truncated).toBe(false);
    expect(found.matches[0]!.page).toBe(2);
    expect(found.matches[0]!.snippet).toContain("Sword blade");
    expect(bytes).toEqual(before);
  });

  it("honors matchCase", async () => {
    const pdf = buildTestPdf([
      "Hello PDF page one",
      "Second page mentions Sword blade",
    ]);
    const none = await searchPdfText(new Uint8Array(pdf), {
      query: "sword",
      matchCase: true,
    });
    expect(none.total).toBe(0);
  });

  it("returns total: 0 for no match", async () => {
    const pdf = buildTestPdf(["nothing relevant here"]);
    const result = await searchPdfText(new Uint8Array(pdf), {
      query: "unfindable",
    });
    expect(result.total).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.matches).toEqual([]);
  });

  it("truncates when there are more matches than the limit", async () => {
    const pdf = buildTestPdf([
      "cat cat cat cat cat cat cat cat cat cat cat cat",
    ]);
    const result = await searchPdfText(new Uint8Array(pdf), {
      query: "cat",
      limit: 3,
    });
    expect(result.total).toBeGreaterThan(3);
    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("clamps limit to the 100 ceiling when the document has more than 100 matches and a larger limit is requested", async () => {
    // Tall MediaBox avoids the fixture's page-edge extraction cutoff; 105 "cat" matches, one per line.
    const pdf = buildMultiLinePdf(105, {
      height: 20_000,
      lineText: (i) => `line ${i} cat`,
    });
    const bytes = new Uint8Array(pdf);
    const before = bytes.slice();
    const result = await searchPdfText(bytes, { query: "cat", limit: 999 });
    expect(result.total).toBe(105);
    expect(result.matches).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(bytes).toEqual(before);
  });

  it.each(["", "   "])(
    "throws invalid_input for the empty query %j instead of looping forever",
    async (query) => {
      const pdf = buildTestPdf(["some text"]);
      const code = await readCode(
        searchPdfText(new Uint8Array(pdf), { query }),
      );
      expect(code).toBe("invalid_input");
    },
  );

  it("treats a NaN limit as the default rather than an empty match budget", async () => {
    const pdf = buildTestPdf(["cat cat"]);
    const result = await searchPdfText(new Uint8Array(pdf), {
      query: "cat",
      limit: Number.NaN,
    });
    expect(result.total).toBe(2);
    expect(result.matches).toHaveLength(2);
  });
});

describe("classifyPdfReadError (password/encrypted mapping)", () => {
  it("maps a PasswordException by name to encrypted, without echoing its message", () => {
    const native = new Error("password required: hunter2");
    native.name = "PasswordException";
    const mapped = classifyPdfReadError(native);
    expect(mapped).toBeInstanceOf(ArtifactReadError);
    expect(mapped.code).toBe("encrypted");
    expect(mapped.message).not.toContain("hunter2");
  });

  it("maps any other error to malformed with the fixed message", () => {
    const native = new Error("Invalid PDF structure: leaked SECRET_XYZ");
    native.name = "InvalidPDFException";
    const mapped = classifyPdfReadError(native);
    expect(mapped.code).toBe("malformed");
    expect(mapped.message).not.toContain("SECRET_XYZ");
    expect(mapped.message).toBe(
      "Unable to read the PDF. Password-protected, encrypted, or invalid files are not supported.",
    );
  });

  it("maps a non-Error thrown value to malformed", () => {
    const mapped = classifyPdfReadError("some string thrown");
    expect(mapped.code).toBe("malformed");
  });
});
