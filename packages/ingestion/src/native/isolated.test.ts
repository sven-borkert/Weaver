import { describe, expect, it } from "vitest";
import { docxFixture, pdfFixture, pngFixture } from "../fixtures";
import type { OcrClient, OcrRoute } from "../ocr";
import { createIsolatedNativeParser } from "./isolated";

const route = {
  snapshot: { displayName: "Test Vision" },
  model: {},
} as OcrRoute;
const ocr: OcrClient = {
  resolve: async () => route,
  transcribe: async () => ({ markdown: "Scanned text" }),
};
const input = {
  fileId: "file",
  projectId: "project",
  jobId: null,
  fileName: "source.docx",
  mimeType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  bytes: docxFixture({ paragraphs: ["Isolated content"] }),
};

describe("isolated native parser", () => {
  it("terminates a child that exceeds the hard deadline", async () => {
    const parser = createIsolatedNativeParser({
      ocr,
      maxOcrPages: 1,
      timeoutMs: 1,
    });
    expect(
      await parser.parse(input, new AbortController().signal),
    ).toMatchObject({ failureKind: "validation", message: /resource limit/ });
  });
  it("returns parsed document content and OCR through the parent provider", async () => {
    const parser = createIsolatedNativeParser({ ocr, maxOcrPages: 1 });
    expect(
      await parser.parse(input, new AbortController().signal),
    ).toMatchObject({ markdown: "Isolated content\n" });
    let resolved = false;
    expect(
      await parser.parse(
        {
          ...input,
          mimeType: "image/png",
          fileName: "scan.png",
          bytes: pngFixture(),
          onRouteResolved: async () => {
            resolved = true;
          },
        },
        new AbortController().signal,
      ),
    ).toMatchObject({ markdown: "Scanned text", ocrPages: 1 });
    expect(resolved).toBe(true);
  });
  it("keeps ordinary PDF OCR within its process memory budget", async () => {
    const parser = createIsolatedNativeParser({ ocr, maxOcrPages: 1 });
    expect(
      await parser.parse(
        {
          ...input,
          mimeType: "application/pdf",
          bytes: pdfFixture(["Typed page", null, null]),
        },
        new AbortController().signal,
      ),
    ).toMatchObject({
      markdown: "Typed page\n\nScanned text",
      ocrPages: 1,
      warnings: ["OCR budget of 1 page reached; 1 scanned page was skipped"],
    });
  });

  it("rejects oversized parser output before sending it back to the worker", async () => {
    const parser = createIsolatedNativeParser({ ocr, maxOcrPages: 1 });
    const result = await parser.parse(
      { ...input, bytes: docxFixture({ paragraphs: ["x".repeat(200001)] }) },
      new AbortController().signal,
    );
    expect("failureKind" in result ? result.failureKind : undefined).toBe(
      "validation",
    );
  });

  it("propagates cancellation without leaving a running parser", async () => {
    const controller = new AbortController();
    const pending = createIsolatedNativeParser({ ocr, maxOcrPages: 1 }).parse(
      input,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
