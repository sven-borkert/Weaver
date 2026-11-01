/** Pure reader for .pdf artifacts (no OCR). unpdf resolves pdf.js into a
 *  process-wide singleton, so this package configures the same legacy build
 *  packages/ingestion does — see the weaver-artifacts skill. */
import { definePDFJSModule, extractText, getMeta } from "unpdf";
import { ArtifactReadError } from "./errors";

const SNIPPET_CONTEXT_CHARS = 80;

const DEFAULT_MAX_CHARS = 40_000;
const MIN_MAX_CHARS = 1_000;
const MAX_MAX_CHARS = 100_000;

const DEFAULT_SEARCH_LIMIT = 20;
const MIN_SEARCH_LIMIT = 1;
const MAX_SEARCH_LIMIT = 100;

const MAX_INFO_VALUE_CHARS = 500;

const UNREADABLE_MESSAGE =
  "Unable to read the PDF. Password-protected, encrypted, or invalid files are not supported.";

export type PdfPageText = { page: number; text: string };

export type PdfSummary = {
  pageCount: number;
  info: Record<string, unknown>;
  pages: Array<{ page: number; chars: number }>;
  totalChars: number;
  warnings: string[];
};

export type PdfPagesResult = {
  pageCount: number;
  startPage: number;
  endPage: number;
  truncated: boolean;
  pages: PdfPageText[];
};

export type PdfSearchMatch = { page: number; snippet: string };

export type PdfSearchResult = {
  pageCount: number;
  total: number;
  truncated: boolean;
  matches: PdfSearchMatch[];
};

/** Never echoes the native error's own message — it can quote file content. */
export function classifyPdfReadError(cause: unknown): ArtifactReadError {
  const name = cause instanceof Error ? cause.name : "";
  if (name === "PasswordException") {
    return new ArtifactReadError(
      "encrypted",
      "PDF is password-protected and cannot be read.",
    );
  }
  return new ArtifactReadError("malformed", UNREADABLE_MESSAGE);
}

let ready: Promise<void> | null = null;

/** Mirrors ingestion's ensurePdfJs: a failed setup clears the memo so the
 *  next call retries. */
function ensurePdfJs(): Promise<void> {
  ready ??= definePDFJSModule(
    () => import("pdfjs-dist/legacy/build/pdf.mjs"),
  ).catch((error: unknown) => {
    ready = null;
    throw error;
  });
  return ready;
}

async function extractPages(data: Uint8Array): Promise<string[]> {
  await ensurePdfJs();
  try {
    // Copy: pdf.js may transfer the underlying buffer it is handed.
    const { text } = await extractText(new Uint8Array(data), {
      mergePages: false,
    });
    return text;
  } catch (cause) {
    throw classifyPdfReadError(cause);
  }
}

const INFO_KEYS = [
  "Title",
  "Author",
  "Subject",
  "Keywords",
  "Creator",
  "Producer",
  "CreationDate",
  "ModDate",
] as const;

function clampInfoValue(value: unknown): unknown {
  return typeof value === "string" && value.length > MAX_INFO_VALUE_CHARS
    ? value.slice(0, MAX_INFO_VALUE_CHARS)
    : value;
}

export async function readPdfSummary(data: Uint8Array): Promise<PdfSummary> {
  const pages = await extractPages(data);
  let info: Record<string, unknown> = {};
  try {
    const meta = await getMeta(new Uint8Array(data));
    const raw = (meta.info ?? {}) as Record<string, unknown>;
    info = Object.fromEntries(
      INFO_KEYS.filter((k) => raw[k] != null && raw[k] !== "").map((k) => [
        k,
        clampInfoValue(raw[k]),
      ]),
    );
  } catch {
    // Metadata is best-effort; a missing info dictionary is not an error.
  }
  const perPage = pages.map((text, i) => ({ page: i + 1, chars: text.length }));
  const totalChars = perPage.reduce((sum, p) => sum + p.chars, 0);
  const warnings =
    totalChars === 0
      ? [
          "No extractable text — the PDF may consist of scanned images. OCR is not supported.",
        ]
      : [];
  return {
    pageCount: pages.length,
    info,
    pages: perPage,
    totalChars,
    warnings,
  };
}

/** Out-of-range limits are clamped (as in the source), but a page number is
 *  an index: 0 or 1.5 would silently read a page that does not exist. */
function requirePageNumber(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1) {
    throw new ArtifactReadError(
      "invalid_input",
      `${label} must be a positive integer.`,
    );
  }
}

function clampNumber(
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (value === undefined || Number.isNaN(value)) return defaultValue;
  return Math.max(min, Math.min(value, max));
}

export async function readPdfPages(
  data: Uint8Array,
  input: { startPage?: number; endPage?: number; maxChars?: number } = {},
): Promise<PdfPagesResult> {
  requirePageNumber(input.startPage, "startPage");
  requirePageNumber(input.endPage, "endPage");
  const pages = await extractPages(data);
  const pageCount = pages.length;
  const startPage = input.startPage ?? 1;
  const maxChars = clampNumber(
    input.maxChars,
    DEFAULT_MAX_CHARS,
    MIN_MAX_CHARS,
    MAX_MAX_CHARS,
  );
  if (startPage > pageCount) {
    throw new ArtifactReadError(
      "not_found",
      `startPage ${startPage} is beyond the last page (${pageCount}).`,
    );
  }
  const endPage = Math.min(input.endPage ?? pageCount, pageCount);
  if (endPage < startPage) {
    throw new ArtifactReadError(
      "invalid_input",
      "endPage must not be smaller than startPage.",
    );
  }

  const out: PdfPageText[] = [];
  let budget = maxChars;
  let truncated = false;
  for (let page = startPage; page <= endPage; page++) {
    const text = pages[page - 1] ?? "";
    if (text.length <= budget) {
      out.push({ page, text });
      budget -= text.length;
    } else {
      out.push({ page, text: text.slice(0, budget) });
      truncated = true;
      break;
    }
  }
  const lastReturned = out.at(-1)?.page ?? startPage;
  return {
    pageCount,
    startPage,
    endPage: truncated ? lastReturned : endPage,
    truncated,
    pages: out,
  };
}

export async function searchPdfText(
  data: Uint8Array,
  input: { query: string; matchCase?: boolean; limit?: number },
): Promise<PdfSearchResult> {
  // An empty needle would match at every offset without advancing.
  if (input.query.trim() === "") {
    throw new ArtifactReadError("invalid_input", "query must not be empty");
  }
  const pages = await extractPages(data);
  const matchCase = input.matchCase ?? false;
  const limit = clampNumber(
    input.limit,
    DEFAULT_SEARCH_LIMIT,
    MIN_SEARCH_LIMIT,
    MAX_SEARCH_LIMIT,
  );
  const needle = matchCase ? input.query : input.query.toLowerCase();
  const matches: PdfSearchMatch[] = [];
  let total = 0;
  for (let i = 0; i < pages.length; i++) {
    const pageText = pages[i]!;
    const haystack = matchCase ? pageText : pageText.toLowerCase();
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      total++;
      if (matches.length < limit) {
        const start = Math.max(0, at - SNIPPET_CONTEXT_CHARS);
        const end = Math.min(
          pageText.length,
          at + needle.length + SNIPPET_CONTEXT_CHARS,
        );
        matches.push({ page: i + 1, snippet: pageText.slice(start, end) });
      }
      from = at + needle.length;
    }
  }
  return {
    pageCount: pages.length,
    total,
    truncated: total > matches.length,
    matches,
  };
}
