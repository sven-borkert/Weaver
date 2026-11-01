import { describe, expect, it } from "vitest";
import { createDoclingParser, DoclingUnreachableError } from "./docling";
import type { ParseInput } from "./parser";

const input = (
  mimeType: string,
  bytes = Buffer.from("%PDF-1.4"),
): ParseInput => ({
  fileId: "f1",
  projectId: "p1",
  jobId: null,
  fileName: "scan.pdf",
  mimeType,
  bytes,
});
const signal = new AbortController().signal;

describe("createDoclingParser", () => {
  it("ingestion review: cancels an oversized response while streaming", async () => {
    let reads = 0;
    let cancelled = false;
    const parser = createDoclingParser({
      baseUrl: "http://d",
      timeoutMs: 1000,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              reads++;
              if (reads > 20) controller.close();
              else controller.enqueue(new Uint8Array(1024 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    expect(await parser.parse(input("application/pdf"), signal)).toMatchObject({
      failureKind: "validation",
    });
    expect(cancelled).toBe(true);
    expect(reads).toBeLessThan(20);
  });

  it("supports PDF and image types only", () => {
    const parser = createDoclingParser({
      baseUrl: "http://docling:5001",
      timeoutMs: 1000,
    });
    expect(
      [
        "application/pdf",
        "image/png",
        "image/jpeg",
        "image/tiff",
        "image/webp",
      ].every((type) => parser.supports(type)),
    ).toBe(true);
    expect(parser.supports("text/csv")).toBe(false);
  });

  it("posts the file as multipart and returns md_content with warnings for partial success", async () => {
    const requests: Array<{ url: string; form: FormData }> = [];
    const parser = createDoclingParser({
      baseUrl: "http://docling:5001/",
      timeoutMs: 1000,
      fetchImpl: async (url, init) => {
        requests.push({ url: url as string, form: init?.body as FormData });
        return Response.json({
          document: { md_content: "# Converted\n\nText" },
          status: "partial_success",
          errors: [{ error_message: "page 3 skipped" }],
        });
      },
    });
    expect(await parser.parse(input("application/pdf"), signal)).toEqual({
      markdown: "# Converted\n\nText",
      tables: [],
      assets: [],
      warnings: [
        "docling-serve reported partial success",
        "docling-serve: page 3 skipped",
      ],
    });
    expect(requests[0]?.url).toBe("http://docling:5001/v1/convert/file");
    expect(requests[0]?.form.getAll("to_formats")).toEqual(["md"]);
    expect((requests[0]?.form.get("files") as File).name).toBe("scan.pdf");
  });

  it("maps a failure status and empty content to parse failures", async () => {
    const failed = createDoclingParser({
      baseUrl: "http://d",
      timeoutMs: 1000,
      fetchImpl: async () =>
        Response.json({
          document: { md_content: "" },
          status: "failure",
          errors: [],
        }),
    });
    expect(await failed.parse(input("application/pdf"), signal)).toMatchObject({
      failureKind: "parser",
      message: /reported failure/,
    });
    const empty = createDoclingParser({
      baseUrl: "http://d",
      timeoutMs: 1000,
      fetchImpl: async () =>
        Response.json({
          document: { md_content: "  " },
          status: "success",
          errors: [],
        }),
    });
    expect(await empty.parse(input("application/pdf"), signal)).toMatchObject({
      failureKind: "validation",
      message: "docling-serve returned no text",
    });
    const http = createDoclingParser({
      baseUrl: "http://d",
      timeoutMs: 1000,
      fetchImpl: async () => new Response("bad", { status: 422 }),
    });
    expect(await http.parse(input("application/pdf"), signal)).toMatchObject({
      failureKind: "parser",
      message: /answered 422/,
    });
  });

  it("raises DoclingUnreachableError for connection and timeout failures", async () => {
    const refused = createDoclingParser({
      baseUrl: "http://d",
      timeoutMs: 1000,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(
      refused.parse(input("application/pdf"), signal),
    ).rejects.toBeInstanceOf(DoclingUnreachableError);
    const slow = createDoclingParser({
      baseUrl: "http://d",
      timeoutMs: 10,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason as Error),
          ),
        ),
    });
    await expect(
      slow.parse(input("application/pdf"), signal),
    ).rejects.toBeInstanceOf(DoclingUnreachableError);
  });
});
