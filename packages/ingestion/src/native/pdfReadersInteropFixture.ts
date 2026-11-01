import { buildTestPdf } from "@weaver/artifact-readers/testing/pdfFixture";
import type {
  PdfPagesResult,
  PdfSearchResult,
  PdfSummary,
} from "@weaver/artifact-readers/pdf";

/**
 * Shared between pdfReadersInteropReaderFirst.test.ts and
 * pdfReadersInteropIngestionFirst.test.ts: one fixture and one set of
 * pinned expected results, so both interop tests assert the exact same
 * values regardless of which package configures unpdf's pdf.js first.
 */
const PAGE_1 = "Hello PDF page one";
const PAGE_2 = "Second page mentions Sword blade";

export function buildInteropPdf() {
  return buildTestPdf([PAGE_1, PAGE_2]);
}

export const expectedSummary: PdfSummary = {
  pageCount: 2,
  info: {},
  pages: [
    { page: 1, chars: PAGE_1.length },
    { page: 2, chars: PAGE_2.length },
  ],
  totalChars: PAGE_1.length + PAGE_2.length,
  warnings: [],
};

export const expectedPages: PdfPagesResult = {
  pageCount: 2,
  startPage: 1,
  endPage: 2,
  truncated: false,
  pages: [
    { page: 1, text: PAGE_1 },
    { page: 2, text: PAGE_2 },
  ],
};

export const expectedSearch: PdfSearchResult = {
  pageCount: 2,
  total: 1,
  truncated: false,
  matches: [{ page: 2, snippet: PAGE_2 }],
};
