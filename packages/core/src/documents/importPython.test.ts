import { describe, expect, it } from "vitest";
import { composeDocumentFile } from "./frontmatter";
import { pythonTitleFromFileName, splitPythonImport } from "./importPython";

describe("pythonTitleFromFileName", () => {
  it("keeps the stem verbatim", () => {
    expect(pythonTitleFromFileName("deploy_prod.py")).toBe("deploy_prod");
    expect(pythonTitleFromFileName("C:\\x\\Deploy Prod.PY")).toBe(
      "Deploy Prod",
    );
    expect(pythonTitleFromFileName(".py")).toBe("Untitled import");
    expect(pythonTitleFromFileName("x".repeat(300) + ".py")).toHaveLength(200);
  });
});

describe("splitPythonImport", () => {
  it("uses the file stem and the whole text without a header", () => {
    expect(splitPythonImport("print(1)\r\n", "tool.py")).toEqual({
      title: "tool",
      body: "print(1)\n",
      review: null,
      appearance: undefined,
    });
  });
  it("takes title, review and appearance from a Weaver header and strips it", () => {
    const review = {
      reviewers: [],
      everyMonths: 3,
      since: "2026-01-01T00:00:00.000Z",
      lastReviewed: null,
      reviewedBy: null,
    };
    const file = composeDocumentFile(
      {
        id: "6f1f39d4-3f6a-4b7e-9a80-0a4c3a3f1b2c",
        title: "My Tool",
        created: "2026-01-01T00:00:00.000Z",
        createdBy: null,
        updated: "2026-01-01T00:00:00.000Z",
        updatedBy: null,
        review,
        appearance: { icon: { type: "builtin", name: "code" } },
      },
      "#!/usr/bin/env python3\npass\n",
      "python",
    );
    expect(splitPythonImport(file, "tool.py")).toEqual({
      title: "My Tool",
      body: "#!/usr/bin/env python3\npass\n",
      review,
      appearance: { icon: { type: "builtin", name: "code" } },
    });
  });
  it("keeps a malformed header as body text", () => {
    const text = "# weaver\n# id: nope\n# /weaver\n\npass\n";
    expect(splitPythonImport(text, "tool.py")).toMatchObject({
      title: "tool",
      body: text,
    });
  });
});
