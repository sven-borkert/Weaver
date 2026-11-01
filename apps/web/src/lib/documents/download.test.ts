import { describe, expect, it } from "vitest";

import { documentDownload, folderArchiveHref } from "./download";

describe("document download links", () => {
  it("names a document download after its stored file", () => {
    expect(
      documentDownload("p1", {
        id: "d1",
        path: "notes/deep/my-plan.md",
        title: "My plan",
        documentKind: "markdown",
      }),
    ).toEqual({
      fileName: "my-plan.md",
      href: "/api/documents/d1/markdown?projectId=p1",
    });
    expect(
      documentDownload("p1", {
        id: "d1",
        path: "readme.md",
        title: "Readme",
        documentKind: "markdown",
      }),
    ).toEqual({
      fileName: "readme.md",
      href: "/api/documents/d1/markdown?projectId=p1",
    });
  });

  it("names a Python download after its title", () => {
    expect(
      documentDownload("p1", {
        id: "d1",
        path: "scripts/deploy-prod.py",
        title: "deploy_prod/v2",
        documentKind: "python",
      }),
    ).toEqual({
      fileName: "deploy_prod-v2.py",
      href: "/api/documents/d1/markdown?projectId=p1",
    });
  });

  it("addresses a folder archive by its path and the root without one", () => {
    expect(folderArchiveHref("p1", ["notes", "deep"])).toBe(
      "/api/projects/p1/folders/archive?path=notes%2Fdeep",
    );
    expect(folderArchiveHref("p1", [])).toBe(
      "/api/projects/p1/folders/archive",
    );
  });
});
