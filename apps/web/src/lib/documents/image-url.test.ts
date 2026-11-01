import { describe, expect, it } from "vitest";
import { resolveDocumentImageUrl } from "./image-url";

const projectId = "11111111-1111-4111-8111-111111111111";

describe("resolveDocumentImageUrl", () => {
  it("renders unavailable for external sources blocked by CSP", () => {
    expect(
      resolveDocumentImageUrl({
        projectId,
        documentPath: "guide.md",
        src: "https://x/a.png",
      }),
    ).toBeUndefined();
  });

  it("resolves relative sources against the document directory", () => {
    expect(
      resolveDocumentImageUrl({
        projectId,
        documentPath: "docs/guide.md",
        src: "guide.assets/Shot 1.png",
      }),
    ).toBe(`/api/projects/${projectId}/files/docs/guide.assets/Shot%201.png`);
    expect(
      resolveDocumentImageUrl({
        projectId,
        documentPath: "docs/sub/guide.md",
        src: "../shared/a.png",
      }),
    ).toBe(`/api/projects/${projectId}/files/docs/shared/a.png`);
    expect(
      resolveDocumentImageUrl({
        projectId,
        documentPath: "guide.md",
        src: "./a.png",
      }),
    ).toBe(`/api/projects/${projectId}/files/a.png`);
  });

  it("appends the pinned commit and applies the base path", () => {
    expect(
      resolveDocumentImageUrl({
        projectId,
        documentPath: "guide.md",
        src: "guide.assets/a.png",
        at: "a".repeat(40),
        basePath: "/weaver",
      }),
    ).toBe(
      `/weaver/api/projects/${projectId}/files/guide.assets/a.png?at=${"a".repeat(40)}`,
    );
  });

  it("returns undefined for escaping paths and other schemes", () => {
    for (const src of [
      "../a.png",
      "data:image/png;base64,AA",
      "javascript:alert(1)",
      "/abs.png",
      "a\\b.png",
      "",
      "a//b.png",
    ]) {
      expect(
        resolveDocumentImageUrl({ projectId, documentPath: "guide.md", src }),
      ).toBeUndefined();
    }
  });
});
