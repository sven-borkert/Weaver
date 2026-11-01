import { definePDFJSModule } from "unpdf";
import type * as UnpdfModule from "unpdf";
import { describe, expect, it, vi } from "vitest";
import { pdfFixture } from "../fixtures";
import { MAX_OCR_IMAGE_EDGE } from "./images";
import {
  closePdf,
  extractPdfPages,
  renderPdfPage,
  type OpenedPdf,
} from "./pdf";

async function openFixture(
  pages: Array<string | null>,
  size?: { width: number; height: number },
): Promise<OpenedPdf> {
  const opened = await extractPdfPages(pdfFixture(pages, size));
  if ("failureKind" in opened) throw new Error(opened.message);
  return opened;
}

/** Width/height from the PNG IHDR chunk, which always starts at byte 16. */
function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// Wraps the real implementation so a test can force exactly one failure, then fall through to real setup.
vi.mock("unpdf", async (importOriginal) => {
  const actual = await importOriginal<typeof UnpdfModule>();
  return { ...actual, definePDFJSModule: vi.fn(actual.definePDFJSModule) };
});

describe("ensurePdfJs", () => {
  it("retries setup after a transient failure instead of wedging forever", async () => {
    vi.mocked(definePDFJSModule).mockImplementationOnce(() =>
      Promise.reject(new Error("simulated setup failure")),
    );
    await expect(extractPdfPages(pdfFixture(["x"]))).rejects.toThrow(
      "simulated setup failure",
    );
    const outcome = await extractPdfPages(pdfFixture(["Recovered"]));
    expect(outcome).toMatchObject({ pageCount: 1 });
    if ("failureKind" in outcome) throw new Error(outcome.message);
    await closePdf(outcome.document);
  });
});

describe("extractPdfPages", () => {
  it("returns per-page text and blank strings for image-only pages", async () => {
    const outcome = await extractPdfPages(
      pdfFixture(["Hello PDF", null, "Third (page)"]),
    );
    expect(outcome).toMatchObject({ pageCount: 3 });
    if ("failureKind" in outcome) throw new Error(outcome.message);
    expect(outcome.texts[0]).toContain("Hello PDF");
    expect(outcome.texts[1]?.trim()).toBe("");
    expect(outcome.texts[2]).toContain("Third (page)");
    await closePdf(outcome.document);
  });

  it("fails an unreadable PDF as a parser failure", async () => {
    expect(await extractPdfPages(Buffer.from("%PDF-1.4 broken"))).toMatchObject(
      {
        failureKind: "parser",
      },
    );
  });
});

describe("renderPdfPage", () => {
  it("rasterizes a page to PNG", async () => {
    const opened = await openFixture([null]);
    const png = await renderPdfPage(opened.document, 1);
    await closePdf(opened.document);
    expect(Array.from(png.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    // Letter at the historical scale 2: the cap must not shrink ordinary pages.
    expect(pngSize(png)).toEqual({ width: 1224, height: 1584 });
  });

  it("releases each page's decoded images without invalidating the document", async () => {
    const opened = await openFixture([null, null]);
    // getPage memoizes, so this is the very proxy renderPdfPage renders and cleans.
    const page = await opened.document.getPage(1);
    const cleanup = vi.spyOn(page, "cleanup");
    await renderPdfPage(opened.document, 1);
    // `true` means pdfjs actually cleared the state, not that it declined a pending render.
    expect(cleanup).toHaveReturnedWith(true);
    expect(page._intentStates.size).toBe(0);
    // The document survives its pages being cleaned: the loop's next page still renders.
    expect(
      (await renderPdfPage(opened.document, 2)).byteLength,
    ).toBeGreaterThan(0);
    await closePdf(opened.document);
  });

  it("renders from the open document, so closing it ends rendering", async () => {
    const opened = await openFixture([null, null]);
    await renderPdfPage(opened.document, 1);
    await closePdf(opened.document);
    await expect(renderPdfPage(opened.document, 2)).rejects.toThrow();
  });

  it("caps the raster at the OCR edge so a huge MediaBox cannot allocate gigabytes", async () => {
    const opened = await openFixture([null], { width: 14_400, height: 14_400 });
    const png = await renderPdfPage(opened.document, 1);
    await closePdf(opened.document);
    const { width, height } = pngSize(png);
    expect(Math.max(width, height)).toBeLessThanOrEqual(MAX_OCR_IMAGE_EDGE);
    expect(Math.max(width, height)).toBeGreaterThan(MAX_OCR_IMAGE_EDGE - 4);
  });
});
