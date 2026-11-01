import { describe, expect, it } from "vitest";
import { isDocumentFileName, partitionDroppedFiles } from "./document-drop";

describe("document-drop", () => {
  it("accepts .md, .markdown and .py case-insensitively", () => {
    expect(isDocumentFileName("Notes.MD")).toBe(true);
    expect(isDocumentFileName("a.markdown")).toBe(true);
    expect(isDocumentFileName("deploy.py")).toBe(true);
    expect(isDocumentFileName("x.PY")).toBe(true);
    expect(isDocumentFileName("a.txt")).toBe(false);
    expect(isDocumentFileName("md")).toBe(false);
    expect(isDocumentFileName(".py")).toBe(false);
  });

  it("partitions dropped files", () => {
    const md = new File(["# a"], "a.md", { type: "text/markdown" });
    const py = new File(["pass"], "deploy.py", { type: "text/x-python" });
    const upper = new File(["pass"], "x.PY");
    const zip = new File(["PK"], "Folder.ZIP", { type: "application/zip" });
    const txt = new File(["b"], "x.txt", { type: "text/plain" });
    expect(partitionDroppedFiles([md, py, upper, zip, txt])).toEqual({
      documents: [md, py, upper],
      archives: [zip],
      ignored: [txt],
    });
  });
});
