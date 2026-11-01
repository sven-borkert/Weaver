import {
  definePDFJSModule,
  extractText,
  getDocumentProxy,
  renderPageAsImage,
} from "unpdf";
import type { ParseFailure } from "../parser";
import { MAX_OCR_IMAGE_EDGE } from "./images";

export const MAX_PDF_PAGES = 2_000;
/** Upper bound only: MediaBox is attacker-controlled, so the edge cap decides on large pages. */
const MAX_PDF_RENDER_SCALE = 2;

export type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;
export type OpenedPdf = {
  pageCount: number;
  texts: string[];
  document: PdfDocument;
};

let ready: Promise<void> | null = null;

/** The official pdfjs build renders; @napi-rs/canvas supplies the DOM globals it expects in Node. */
function ensurePdfJs(): Promise<void> {
  ready ??= (async () => {
    const canvas = await import("@napi-rs/canvas");
    const globals = globalThis as Record<string, unknown>;
    globals.DOMMatrix ??= canvas.DOMMatrix;
    globals.ImageData ??= canvas.ImageData;
    globals.Path2D ??= canvas.Path2D;
    // The main pdfjs-dist build assumes Uint8Array#toHex, unshipped in this Node; the legacy build doesn't.
    await definePDFJSModule(() => import("pdfjs-dist/legacy/build/pdf.mjs"));
  })().catch((error: unknown) => {
    // Don't wedge every later call on a transient setup failure; let the next call retry.
    ready = null;
    throw error;
  });
  return ready;
}

/** Frees the pdfjs worker and its page cache; safe to call twice. */
export async function closePdf(document: PdfDocument): Promise<void> {
  await document.loadingTask.destroy().catch(() => undefined);
}

/** The caller owns the returned document and must closePdf() it. */
export async function extractPdfPages(
  bytes: Buffer,
): Promise<OpenedPdf | ParseFailure> {
  await ensurePdfJs();
  let pdf: PdfDocument | null = null;
  try {
    // isEvalSupported is gone from this pdfjs-dist: it no longer has an eval-based font path to gate.
    pdf = await getDocumentProxy(new Uint8Array(bytes));
    if (pdf.numPages > MAX_PDF_PAGES) {
      await closePdf(pdf);
      return {
        failureKind: "validation",
        message: `the PDF has more than ${MAX_PDF_PAGES} pages`,
      };
    }
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    return { pageCount: totalPages, texts: text, document: pdf };
  } catch {
    if (pdf) await closePdf(pdf);
    return {
      failureKind: "parser",
      message: "the PDF could not be read (damaged or encrypted)",
    };
  }
}

/** Takes the open document, not the bytes: unpdf re-parses the whole file per call otherwise. */
export async function renderPdfPage(
  document: PdfDocument,
  pageNumber: number,
): Promise<Uint8Array> {
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const scale = Math.min(
    MAX_PDF_RENDER_SCALE,
    MAX_OCR_IMAGE_EDGE / Math.max(1, viewport.width, viewport.height),
  );
  try {
    const image = await renderPageAsImage(document, pageNumber, {
      canvasImport: () => import("@napi-rs/canvas"),
      scale,
    });
    return new Uint8Array(image);
  } finally {
    // pdfjs self-cleans only after a print-intent render; release the decoded page images here.
    page.cleanup();
  }
}
