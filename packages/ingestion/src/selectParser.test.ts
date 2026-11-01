import { describe, expect, it, vi } from "vitest";
import { DEFAULT_INGESTION_SETTINGS } from "@weaver/core/ingestion/settings";
import { DoclingUnreachableError } from "./docling";
import { emptyDocument, type DocumentParser, type ParseInput } from "./parser";
import { parsersFor, parseWithFallback } from "./selectParser";

const native: DocumentParser = {
  id: "native",
  version: "1",
  supports: (type) => type !== "image/tiff",
  parse: async () => emptyDocument("native"),
};
const input: ParseInput = {
  fileId: "f",
  projectId: "p",
  jobId: null,
  fileName: "a.pdf",
  mimeType: "application/pdf",
  bytes: Buffer.alloc(0),
};
const signal = new AbortController().signal;

describe("parsersFor", () => {
  it("prefers Docling only when configured", () => {
    expect(
      parsersFor(DEFAULT_INGESTION_SETTINGS, native).map((parser) => parser.id),
    ).toEqual(["native"]);
    expect(
      parsersFor(
        { ...DEFAULT_INGESTION_SETTINGS, doclingBaseUrl: "http://d" },
        native,
      ).map((parser) => parser.id),
    ).toEqual(["docling", "native"]);
  });
});

describe("parseWithFallback", () => {
  it("falls back to the native adapter when Docling is unreachable", async () => {
    const docling: DocumentParser = {
      id: "docling",
      version: "1",
      supports: () => true,
      parse: async () => {
        throw new DoclingUnreachableError("down");
      },
    };
    const selected: string[] = [];
    const result = await parseWithFallback(
      [docling, native],
      input,
      signal,
      async (parser) => {
        selected.push(parser.id);
      },
    );
    expect(selected).toEqual(["docling", "native"]);
    expect(result).toMatchObject({
      parser: { id: "native" },
      outcome: {
        markdown: "native",
        warnings: [
          "docling-serve was unreachable; the file was parsed natively",
        ],
      },
    });
  });

  it("returns null when nothing supports the type and keeps Docling failures", async () => {
    expect(
      await parseWithFallback(
        [native],
        { ...input, mimeType: "image/tiff" },
        signal,
        vi.fn(),
      ),
    ).toBeNull();
    const docling: DocumentParser = {
      id: "docling",
      version: "1",
      supports: () => true,
      parse: async () => ({ failureKind: "parser", message: "docling failed" }),
    };
    expect(
      await parseWithFallback([docling, native], input, signal, vi.fn()),
    ).toMatchObject({
      parser: { id: "docling" },
      outcome: { failureKind: "parser" },
    });
  });
});
