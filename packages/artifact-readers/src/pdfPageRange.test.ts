import { beforeEach, describe, expect, it, vi } from "vitest";
import { readPdfPages } from "./pdf";

const pdf = vi.hoisted(() => ({
  getDocumentProxy: vi.fn(),
  getPage: vi.fn(),
  destroy: vi.fn(async () => undefined),
}));
vi.mock("unpdf", () => ({
  definePDFJSModule: vi.fn(async () => undefined),
  getDocumentProxy: pdf.getDocumentProxy,
  extractText: vi.fn(async () => ({ text: ["first", "second", "third"] })),
}));

describe("paged PDF extraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pdf.getDocumentProxy.mockResolvedValue({
      numPages: 3,
      getPage: pdf.getPage,
      loadingTask: { destroy: pdf.destroy },
    });
  });

  it("opens one document and extracts only the requested pages", async () => {
    pdf.getPage.mockResolvedValue({
      getTextContent: async () => ({
        items: [{ str: "first line", hasEOL: true }, { str: "second line" }],
      }),
    });
    const result = await readPdfPages(new Uint8Array(), {
      startPage: 2,
      endPage: 2,
    });
    expect(pdf.getDocumentProxy).toHaveBeenCalledOnce();
    expect(pdf.getPage.mock.calls).toEqual([[2]]);
    expect(result.pages).toEqual([
      { page: 2, text: "first line\nsecond line" },
    ]);
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });

  it("stops at the character budget", async () => {
    pdf.getPage.mockResolvedValue({
      getTextContent: async () => ({ items: [{ str: "x".repeat(1050) }] }),
    });
    const result = await readPdfPages(new Uint8Array(), { maxChars: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.pages[0]?.text).toHaveLength(1000);
    expect(pdf.getPage.mock.calls).toEqual([[1]]);
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });

  it("returns a continuation at the next page when the budget fits exactly", async () => {
    pdf.getPage.mockResolvedValue({
      getTextContent: async () => ({ items: [{ str: "x".repeat(1000) }] }),
    });
    const result = await readPdfPages(new Uint8Array(), { maxChars: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.pages[1]).toEqual({ page: 2, text: "" });
    expect(pdf.getPage.mock.calls).toEqual([[1]]);
  });
});
