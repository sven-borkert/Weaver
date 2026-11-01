import { MAX_MARKDOWN_CHARS } from "@weaver/core/documents/limits";
import { normalizeMimeType } from "@weaver/core/ingestion/mimeTypes";
import type { OcrClient, OcrRoute } from "../ocr";
import {
  emptyDocument,
  type DocumentParser,
  type ParsedDocument,
  type ParseFailure,
  type ParseInput,
  type ParseOutcome,
} from "../parser";
import { parseDocx } from "./docx";
import { normalizeImageForOcr } from "./images";
import {
  closePdf,
  extractPdfPages,
  renderPdfPage,
  type OpenedPdf,
} from "./pdf";
import { decodeUtf8Text, parseText } from "./text";
import { parseCsvTable, parseXlsx } from "./xlsx";

export const NATIVE_PARSER_ID = "native";
export const NATIVE_PARSER_VERSION = "1";

const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const SPREADSHEET_TYPES: ReadonlySet<string> = new Set([
  "text/csv",
  XLSX,
]);
export const OCR_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const SUPPORTED: ReadonlySet<string> = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  DOCX,
  XLSX,
  "application/pdf",
  ...OCR_IMAGE_TYPES,
]);

/** Bounds the whole OCR loop, well inside INGESTION_PARSE_EXPIRE_IN_SECONDS. */
export const MAX_OCR_WALL_CLOCK_MS = 30 * 60_000;

export type NativeParserDeps = {
  ocr: OcrClient;
  maxOcrPages: number;
  /** Test seam for the OCR wall clock. */
  now?: () => number;
};

export function unsupportedMessage(
  mimeType: string,
  doclingConfigured: boolean,
): string {
  const type = normalizeMimeType(mimeType);
  if (type === "application/msword" || type === "application/vnd.ms-excel") {
    return "legacy Word/Excel binary formats are not supported; save the file as .docx/.xlsx and upload it again";
  }
  if (type === "image/tiff") {
    return doclingConfigured
      ? "image/tiff is parsed only by docling-serve, which reported the file as unsupported"
      : "image/tiff needs a configured docling-serve endpoint (Administration › AI › Document parsing)";
  }
  return `no parser supports ${type}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function createNativeParser(deps: NativeParserDeps): DocumentParser {
  let cachedRoute: OcrRoute | null = null;

  async function ocrRoute(input: ParseInput): Promise<OcrRoute | ParseFailure> {
    if (cachedRoute) return cachedRoute;
    const resolved = await deps.ocr.resolve();
    if ("failureKind" in resolved) return resolved;
    await input.onRouteResolved?.(resolved.snapshot);
    cachedRoute = resolved;
    return resolved;
  }

  async function parseImage(
    input: ParseInput,
    signal: AbortSignal,
  ): Promise<ParseOutcome> {
    if (deps.maxOcrPages === 0) {
      return {
        failureKind: "parser",
        message:
          "OCR is disabled (WEAVER_INGESTION_MAX_OCR_PAGES=0), so images cannot be imported",
      };
    }
    const png = await normalizeImageForOcr(input.bytes);
    if (!png)
      return {
        failureKind: "validation",
        message: "the image could not be decoded",
      };
    const route = await ocrRoute(input);
    if ("failureKind" in route) return route;
    signal.throwIfAborted();
    const page = await deps.ocr.transcribe(
      route,
      {
        png,
        projectId: input.projectId,
        fileId: input.fileId,
        jobId: input.jobId,
        page: null,
      },
      signal,
    );
    if ("failureKind" in page) return page;
    return { ...emptyDocument(page.markdown), ocrPages: 1 };
  }

  async function parsePdf(
    input: ParseInput,
    signal: AbortSignal,
  ): Promise<ParseOutcome> {
    const opened = await extractPdfPages(input.bytes);
    if ("failureKind" in opened) return opened;
    try {
      return await transcribePdf(input, signal, opened);
    } finally {
      await closePdf(opened.document);
    }
  }

  async function transcribePdf(
    input: ParseInput,
    signal: AbortSignal,
    pages: OpenedPdf,
  ): Promise<ParseOutcome> {
    const scanned = pages.texts
      .map((text, index) => ({ text, page: index + 1 }))
      .filter((page) => page.text.trim().length === 0);
    const warnings: string[] = [];
    const transcripts = new Map<number, string>();
    let route: OcrRoute | null = null;
    if (scanned.length > 0 && deps.maxOcrPages === 0) {
      warnings.push(
        `OCR is disabled; ${plural(scanned.length, "scanned page")} ${scanned.length === 1 ? "was" : "were"} skipped`,
      );
    } else if (scanned.length > 0) {
      const resolved = await ocrRoute(input);
      if ("failureKind" in resolved) return resolved;
      route = resolved;
      const clock = deps.now ?? Date.now;
      const deadline = clock() + MAX_OCR_WALL_CLOCK_MS;
      const budgeted = scanned.slice(0, deps.maxOcrPages);
      let attempted = 0;
      let unrenderable = 0;
      for (const page of budgeted) {
        signal.throwIfAborted();
        if (clock() >= deadline) break;
        attempted += 1;
        let png: Uint8Array;
        try {
          png = await renderPdfPage(pages.document, page.page);
        } catch {
          unrenderable += 1;
          continue;
        }
        const result = await deps.ocr.transcribe(
          route,
          {
            png,
            projectId: input.projectId,
            fileId: input.fileId,
            jobId: input.jobId,
            page: page.page,
          },
          signal,
        );
        if ("failureKind" in result) return result;
        transcripts.set(page.page, result.markdown);
      }
      const skipped = scanned.length - budgeted.length;
      if (skipped > 0) {
        warnings.push(
          `OCR budget of ${plural(deps.maxOcrPages, "page")} reached; ${plural(skipped, "scanned page")} ${skipped === 1 ? "was" : "were"} skipped`,
        );
      }
      const expired = budgeted.length - attempted;
      if (expired > 0) {
        warnings.push(
          `the OCR time budget was reached; ${plural(expired, "scanned page")} ${expired === 1 ? "was" : "were"} skipped`,
        );
      }
      if (unrenderable > 0) {
        warnings.push(
          `${plural(unrenderable, "scanned page")} could not be rasterized and ${unrenderable === 1 ? "was" : "were"} skipped`,
        );
      }
    }
    const markdown = pages.texts
      .map((text, index) => transcripts.get(index + 1) ?? text.trim())
      .filter((text) => text.length > 0)
      .join("\n\n");
    if (markdown.length > MAX_MARKDOWN_CHARS) {
      return {
        failureKind: "validation",
        message: `parsed content exceeds ${MAX_MARKDOWN_CHARS} characters`,
      };
    }
    const document: ParsedDocument = {
      ...emptyDocument(markdown, warnings),
      pageCount: pages.pageCount,
      ocrPages: transcripts.size,
    };
    return document;
  }

  return {
    id: NATIVE_PARSER_ID,
    version: NATIVE_PARSER_VERSION,
    supports: (mimeType) => SUPPORTED.has(normalizeMimeType(mimeType)),
    async parse(input, signal) {
      const type = normalizeMimeType(input.mimeType);
      signal.throwIfAborted();
      if (type === "text/plain" || type === "text/markdown")
        return parseText({ mimeType: type, bytes: input.bytes });
      if (type === "text/csv") {
        const decoded = decodeUtf8Text(input.bytes);
        if (typeof decoded !== "string") return decoded;
        const csv = parseCsvTable(decoded);
        return "failureKind" in csv
          ? csv
          : { ...emptyDocument("", csv.warnings), tables: csv.tables };
      }
      if (type === XLSX) {
        const xlsx = await parseXlsx(input.bytes);
        return "failureKind" in xlsx
          ? xlsx
          : { ...emptyDocument("", xlsx.warnings), tables: xlsx.tables };
      }
      if (type === DOCX) return parseDocx(input.bytes);
      if (type === "application/pdf") return parsePdf(input, signal);
      if (OCR_IMAGE_TYPES.has(type)) return parseImage(input, signal);
      return {
        failureKind: "parser",
        message: unsupportedMessage(type, false),
      };
    },
  };
}
