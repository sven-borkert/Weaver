import { describe, expect, it } from "vitest";
import {
  DOCUMENT_KINDS,
  DocumentKindError,
  documentFileExtension,
  documentFileStem,
  documentImportExtensions,
  documentKindFromFileName,
  documentKindFromPath,
  documentKindOfPath,
} from "./kinds";

describe("document kinds", () => {
  it("maps stored extensions to kinds", () => {
    expect(documentKindFromPath("guides/setup.md")).toBe("markdown");
    expect(documentKindFromPath("scripts/deploy.py")).toBe("python");
    expect(documentKindFromPath("notes.markdown")).toBeNull();
    expect(documentKindFromPath("Deploy.PY")).toBeNull();
    expect(documentKindFromPath(".md")).toBeNull();
    expect(documentKindFromPath("docs/.py")).toBeNull();
    expect(documentKindFromPath("tables/x.table/schema.json")).toBeNull();
  });
  it("throws for a path without a registered extension", () => {
    expect(documentKindOfPath("a/b.py")).toBe("python");
    expect(() => documentKindOfPath("a/b.txt")).toThrow(DocumentKindError);
  });
  it("maps import file names case-insensitively", () => {
    expect(documentKindFromFileName("README.MD")).toBe("markdown");
    expect(documentKindFromFileName("notes.markdown")).toBe("markdown");
    expect(documentKindFromFileName("C:\\tmp\\Deploy_Prod.Py")).toBe("python");
    expect(documentKindFromFileName("archive.zip")).toBeNull();
    expect(documentKindFromFileName(".py")).toBeNull();
  });
  it("strips only registered extensions from a basename", () => {
    expect(documentFileStem("docs/deploy-prod.py")).toBe("deploy-prod");
    expect(documentFileStem("docs/guide.md")).toBe("guide");
    expect(documentFileStem("docs/data.jsonl")).toBe("data.jsonl");
  });
  it("exposes extensions and capabilities", () => {
    expect(documentFileExtension("markdown")).toBe(".md");
    expect(documentFileExtension("python")).toBe(".py");
    expect(documentImportExtensions()).toEqual([".md", ".markdown", ".py"]);
    expect(DOCUMENT_KINDS.python).toMatchObject({
      mimeType: "text/x-python",
      supportsImages: false,
      supportsPdf: false,
      supportsRemoteSend: false,
    });
    expect(DOCUMENT_KINDS.markdown.supportsImages).toBe(true);
  });
});
