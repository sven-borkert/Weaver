import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOCUMENT_IMAGE_ACCEPT,
  altFromFileName,
  isDocumentImageFile,
  uploadDocumentImage,
} from "./image-upload";

describe("image upload helpers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("derives readable alt text from a file name", () => {
    expect(altFromFileName("Screen_Shot-2026.png")).toBe("Screen Shot 2026");
    expect(altFromFileName("")).toBe("");
    expect(altFromFileName("image.png")).toBe("image");
  });

  it("accepts only the allowlisted types", () => {
    expect(DOCUMENT_IMAGE_ACCEPT).toBe(
      "image/png,image/jpeg,image/webp,image/gif",
    );
    expect(
      isDocumentImageFile(new File([""], "a.png", { type: "image/png" })),
    ).toBe(true);
    expect(
      isDocumentImageFile(new File([""], "a.svg", { type: "image/svg+xml" })),
    ).toBe(false);
  });

  it("passes cancellation to the upload request so discarded work can stop", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      init.signal?.throwIfAborted();
      return new Response(JSON.stringify({ src: "late.assets/image.png" }));
    });
    await expect(
      uploadDocumentImage({
        projectId: "p",
        documentId: "d",
        file: new File(["x"], "a.png", { type: "image/png" }),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it("posts multipart to the document route and surfaces the error message", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const form = init.body as FormData;
      expect(form.get("projectId")).toBe("p");
      expect((form.get("file") as File).name).toBe("a.png");
      return new Response(
        JSON.stringify({
          src: "doc.assets/a.png",
          path: "doc.assets/a.png",
          url: "/api/x",
          contentType: "image/png",
          byteSize: 1,
          commitSha: "0".repeat(40),
        }),
        { status: 201 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await uploadDocumentImage({
      projectId: "p",
      documentId: "d",
      file: new File(["x"], "a.png", { type: "image/png" }),
    });
    expect(result.src).toBe("doc.assets/a.png");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/documents/d/images");

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "unsupported image type" }), {
            status: 415,
          }),
      ),
    );
    await expect(
      uploadDocumentImage({
        projectId: "p",
        documentId: "d",
        file: new File(["x"], "a.png", { type: "image/png" }),
      }),
    ).rejects.toThrow("unsupported image type");
  });
});
