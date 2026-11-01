import {
  readPdfPages,
  readPdfSummary,
  searchPdfText,
} from "@weaver/artifact-readers/pdf";
import { describe, expect, it } from "vitest";
import { closePdf, extractPdfPages } from "./pdf";
import {
  buildInteropPdf,
  expectedPages,
  expectedSearch,
  expectedSummary,
} from "./pdfReadersInteropFixture";

/**
 * Runs in its own Vitest worker (a separate file, Vitest's default
 * per-file isolation), so unpdf's process-wide pdf.js module starts
 * unconfigured here — the mirror image of
 * pdfReadersInteropReaderFirst.test.ts's order. See pdf.ts's module
 * comment.
 */
describe("PDF reader / ingestion pdf.js interop — ingestion configures first", () => {
  it("reader results are identical to the reader-first order after ingestion opens a PDF first", async () => {
    const pdf = buildInteropPdf();
    const bytes = new Uint8Array(pdf);

    const opened = await extractPdfPages(pdf);
    if ("failureKind" in opened) throw new Error(opened.message);
    expect(opened.pageCount).toBe(2);
    await closePdf(opened.document);

    const after = {
      summary: await readPdfSummary(bytes),
      pages: await readPdfPages(bytes),
      search: await searchPdfText(bytes, { query: "sword" }),
    };
    expect(after.summary).toEqual(expectedSummary);
    expect(after.pages).toEqual(expectedPages);
    expect(after.search).toEqual(expectedSearch);
  });
});
