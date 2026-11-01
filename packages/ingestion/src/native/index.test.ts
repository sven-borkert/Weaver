import { describe, expect, it, vi } from "vitest";
import {
  knowledgeJobExpireInSeconds,
  KNOWLEDGE_JOB_EXPIRE_IN_SECONDS,
} from "@weaver/core/jobs/types";
import type { LlmModelSnapshot } from "@weaver/core/services/llmRoutes";
import { docxFixture, pdfFixture, pngFixture, xlsxFixture } from "../fixtures";
import type { OcrClient, OcrRoute } from "../ocr";
import type { ParseInput } from "../parser";
import {
  createNativeParser,
  MAX_OCR_WALL_CLOCK_MS,
  unsupportedMessage,
} from "./index";
import type * as PdfModule from "./pdf";
import { renderPdfPage } from "./pdf";

// Real rasterization by default; a test can force one page to fail.
vi.mock("./pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof PdfModule>();
  return { ...actual, renderPdfPage: vi.fn(actual.renderPdfPage) };
});

const snapshot = {
  providerModelId: "vision",
  displayName: "Vision",
  capabilities: ["chat", "vision"],
} as LlmModelSnapshot;
const route: OcrRoute = { snapshot, model: {} as never };

function ocrClient(pages: string[]): OcrClient & { calls: number } {
  const client = {
    calls: 0,
    resolve: vi.fn(async () => route),
    transcribe: vi.fn(async () => ({ markdown: pages[client.calls++] ?? "" })),
  };
  return client;
}
const blockedOcr: OcrClient = {
  resolve: async () => ({
    failureKind: "configuration",
    message: "no vision route",
  }),
  transcribe: async () => {
    throw new Error("unreachable");
  },
};
const input = (
  fileName: string,
  mimeType: string,
  bytes: Buffer,
  extra: Partial<ParseInput> = {},
): ParseInput => ({
  fileId: "f1",
  projectId: "p1",
  jobId: "j1",
  fileName,
  mimeType,
  bytes,
  ...extra,
});
const signal = new AbortController().signal;
const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("createNativeParser", () => {
  const parser = createNativeParser({ ocr: ocrClient([]), maxOcrPages: 50 });

  it("declares the formats it can parse", () => {
    for (const type of [
      "text/plain",
      "text/markdown",
      "text/csv",
      DOCX,
      XLSX,
      "application/pdf",
      "image/png",
      "image/jpeg",
      "image/webp",
    ]) {
      expect(parser.supports(type)).toBe(true);
    }
    for (const type of [
      "application/msword",
      "application/vnd.ms-excel",
      "image/tiff",
    ]) {
      expect(parser.supports(type)).toBe(false);
    }
    expect(unsupportedMessage("image/tiff", false)).toMatch(/docling-serve/);
    expect(unsupportedMessage("application/msword", true)).toMatch(/\.docx/);
  });

  it("routes text, DOCX, XLSX, CSV, and text PDFs to their adapters", async () => {
    expect(
      await parser.parse(
        input("a.md", "text/markdown", Buffer.from("# A\n")),
        signal,
      ),
    ).toMatchObject({ markdown: "# A\n" });
    expect(
      await parser.parse(
        input("a.docx", DOCX, docxFixture({ paragraphs: ["Doc"] })),
        signal,
      ),
    ).toMatchObject({ markdown: "Doc\n" });
    expect(
      await parser.parse(
        input(
          "a.xlsx",
          XLSX,
          await xlsxFixture([{ name: "S", rows: [["h"], ["v"]] }]),
        ),
        signal,
      ),
    ).toMatchObject({
      markdown: "",
      tables: [{ columns: ["h"], rows: [["v"]] }],
    });
    expect(
      await parser.parse(
        input("a.csv", "text/csv", Buffer.from("h\nv\n")),
        signal,
      ),
    ).toMatchObject({ tables: [{ columns: ["h"], rows: [["v"]] }] });
    const pdf = await parser.parse(
      input("a.pdf", "application/pdf", pdfFixture(["Page one", "Page two"])),
      signal,
    );
    expect(pdf).toMatchObject({ pageCount: 2, ocrPages: 0 });
    if ("failureKind" in pdf) throw new Error(pdf.message);
    expect(pdf.markdown).toContain("Page one");
    expect(pdf.markdown).toContain("Page two");
  });

  it("transcribes images and image-only PDF pages within the budget", async () => {
    const ocr = ocrClient(["# Scan one", "# Scan two"]);
    const onRouteResolved = vi.fn(async () => undefined);
    const budgeted = createNativeParser({ ocr, maxOcrPages: 1 });
    expect(
      await budgeted.parse(
        input("s.png", "image/png", pngFixture(), { onRouteResolved }),
        signal,
      ),
    ).toMatchObject({ markdown: "# Scan one", ocrPages: 1 });
    expect(onRouteResolved).toHaveBeenCalledWith(snapshot);
    const pdf = await budgeted.parse(
      input("s.pdf", "application/pdf", pdfFixture(["Text page", null, null])),
      signal,
    );
    expect(pdf).toMatchObject({
      pageCount: 3,
      ocrPages: 1,
      warnings: ["OCR budget of 1 page reached; 1 scanned page was skipped"],
    });
    if ("failureKind" in pdf) throw new Error(pdf.message);
    // Exact string, not two independent toContain calls: pins page order,
    // not just presence, of the interleaved typed/transcribed pages.
    expect(pdf.markdown).toBe("Text page\n\n# Scan two");
    expect(ocr.calls).toBe(2);
  });

  it("resolves the OCR route once per parse and notifies onRouteResolved before the first transcription", async () => {
    const order: string[] = [];
    const pages = ["# Scan two", "# Scan three"];
    let resolves = 0;
    const ocr: OcrClient = {
      resolve: async () => {
        resolves += 1;
        return route;
      },
      transcribe: async () => {
        order.push("transcribe");
        return { markdown: pages.shift() ?? "" };
      },
    };
    const onRouteResolved = vi.fn(async () => {
      order.push("route-resolved");
    });
    const multiPage = createNativeParser({ ocr, maxOcrPages: 50 });
    const pdf = await multiPage.parse(
      input("s.pdf", "application/pdf", pdfFixture(["Text page", null, null]), {
        onRouteResolved,
      }),
      signal,
    );
    expect(pdf).toMatchObject({ pageCount: 3, ocrPages: 2, warnings: [] });
    if ("failureKind" in pdf) throw new Error(pdf.message);
    expect(pdf.markdown).toBe("Text page\n\n# Scan two\n\n# Scan three");
    // Two transcribed pages but one resolve() call: the route is cached.
    expect(resolves).toBe(1);
    expect(onRouteResolved).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["route-resolved", "transcribe", "transcribe"]);
  });

  it("blocks scans without a vision route and disables OCR at budget zero", async () => {
    const blocked = createNativeParser({ ocr: blockedOcr, maxOcrPages: 50 });
    expect(
      await blocked.parse(input("s.png", "image/png", pngFixture()), signal),
    ).toMatchObject({
      failureKind: "configuration",
      message: "no vision route",
    });
    expect(
      await blocked.parse(
        input("s.pdf", "application/pdf", pdfFixture([null])),
        signal,
      ),
    ).toMatchObject({ failureKind: "configuration" });
    const disabled = createNativeParser({ ocr: blockedOcr, maxOcrPages: 0 });
    expect(
      await disabled.parse(input("s.png", "image/png", pngFixture()), signal),
    ).toMatchObject({ failureKind: "parser", message: /OCR is disabled/ });
    expect(
      await disabled.parse(
        input("s.pdf", "application/pdf", pdfFixture(["Text", null])),
        signal,
      ),
    ).toMatchObject({
      ocrPages: 0,
      warnings: ["OCR is disabled; 1 scanned page was skipped"],
    });
  });

  it("stops OCR at the wall-clock budget with a warning, not a failure", async () => {
    const ocr = ocrClient(["# Scan one", "# Scan two", "# Scan three"]);
    const times = [0, 0, 20 * 60_000, 40 * 60_000];
    const timed = createNativeParser({
      ocr,
      maxOcrPages: 50,
      now: () => times.shift() ?? 40 * 60_000,
    });
    const pdf = await timed.parse(
      input(
        "s.pdf",
        "application/pdf",
        pdfFixture(["Text page", null, null, null]),
      ),
      signal,
    );
    expect(pdf).toMatchObject({
      pageCount: 4,
      ocrPages: 2,
      warnings: ["the OCR time budget was reached; 1 scanned page was skipped"],
    });
    if ("failureKind" in pdf) throw new Error(pdf.message);
    expect(pdf.markdown).toBe("Text page\n\n# Scan one\n\n# Scan two");
    expect(ocr.calls).toBe(2);
  });

  it("keeps the OCR wall clock inside the ingestion.parse job lease", () => {
    expect(knowledgeJobExpireInSeconds("ingestion.parse")).toBeGreaterThan(
      KNOWLEDGE_JOB_EXPIRE_IN_SECONDS,
    );
    expect(MAX_OCR_WALL_CLOCK_MS).toBeLessThan(
      knowledgeJobExpireInSeconds("ingestion.parse") * 1_000,
    );
  });

  it("skips a page it cannot rasterize instead of throwing out of the parser", async () => {
    const ocr = ocrClient(["# Scan two"]);
    const resilient = createNativeParser({ ocr, maxOcrPages: 50 });
    vi.mocked(renderPdfPage).mockRejectedValueOnce(new Error("canvas failed"));
    const pdf = await resilient.parse(
      input("s.pdf", "application/pdf", pdfFixture(["Text page", null, null])),
      signal,
    );
    expect(pdf).toMatchObject({
      pageCount: 3,
      ocrPages: 1,
      warnings: ["1 scanned page could not be rasterized and was skipped"],
    });
    if ("failureKind" in pdf) throw new Error(pdf.message);
    expect(pdf.markdown).toBe("Text page\n\n# Scan two");
    expect(ocr.calls).toBe(1);
  });

  it("propagates OCR provider failures and rejects undecodable images", async () => {
    const failing: OcrClient = {
      resolve: async () => route,
      transcribe: async () => ({
        failureKind: "provider",
        message: "provider request failed",
      }),
    };
    expect(
      await createNativeParser({ ocr: failing, maxOcrPages: 50 }).parse(
        input("s.png", "image/png", pngFixture()),
        signal,
      ),
    ).toMatchObject({ failureKind: "provider" });
    expect(
      await parser.parse(
        input("s.png", "image/png", Buffer.from("nope")),
        signal,
      ),
    ).toMatchObject({
      failureKind: "validation",
      message: "the image could not be decoded",
    });
  });
});
