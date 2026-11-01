import { describe, expect, it } from "vitest";
import { applyDocumentPatch, type PatchAction } from "./patch";

const MD = [
  "# Alpha",
  "",
  "Alpha body with token here.",
  "",
  "## Beta",
  "",
  "Beta body.",
  "",
  "# Gamma",
  "",
  "Gamma body.",
  "",
].join("\n");

const apply = (...actions: PatchAction[]) =>
  applyDocumentPatch(MD, actions, "markdown");

describe("replace_text", () => {
  it("replaces a unique match", () => {
    expect(
      apply({ action: "replace_text", find: "token", replace: "WORD" }),
    ).toContain("Alpha body with WORD here.");
  });

  it("refuses zero and multiple matches", () => {
    expect(() =>
      apply({ action: "replace_text", find: "nope", replace: "x" }),
    ).toThrow(/matched 0 times/);
    expect(() =>
      apply({ action: "replace_text", find: "body", replace: "x" }),
    ).toThrow(/matched 3 times/);
  });

  it("allows a bounded multi-match replacement with an explicit count", () => {
    const out = apply({
      action: "replace_text",
      find: "body",
      replace: "BODY",
      expectedMatches: 3,
    });
    expect(out.match(/BODY/g)).toHaveLength(3);
  });

  it("confines the search to a section", () => {
    const out = apply({
      action: "replace_text",
      find: "body",
      replace: "B",
      sectionId: "section-alpha--beta",
    });
    expect(out).toContain("Beta B.");
    expect(out).toContain("Alpha body with token here.");
    expect(out).toContain("Gamma body.");
  });

  it("reports AMBIGUOUS_MATCH as the structured reason", () => {
    expect.assertions(1);
    try {
      apply({ action: "replace_text", find: "body", replace: "x" });
    } catch (error) {
      expect((error as { details?: { reason?: string } }).details?.reason).toBe(
        "AMBIGUOUS_MATCH",
      );
    }
  });
});

describe("section actions", () => {
  it("removes a heading and its whole subtree", () => {
    expect(
      apply({ action: "remove_section", sectionId: "section-alpha--beta" }),
    ).toBe(
      "# Alpha\n\nAlpha body with token here.\n\n# Gamma\n\nGamma body.\n",
    );
  });

  it("replaces a section body but keeps its heading", () => {
    const out = apply({
      action: "replace_section_body",
      sectionId: "section-gamma",
      text: "new gamma\n",
    });
    expect(out).toContain("# Gamma\nnew gamma\n");
    expect(out).not.toContain("Gamma body.");
  });

  it("removing a parent removes its descendants", () => {
    const out = apply({ action: "remove_section", sectionId: "section-alpha" });
    expect(out).not.toContain("## Beta");
    expect(out).toContain("# Gamma");
  });

  it("rejects an unknown section id", () => {
    expect(() =>
      apply({ action: "remove_section", sectionId: "section-nope" }),
    ).toThrow(/unknown section/);
  });
});

describe("insertion actions", () => {
  it("prepends and appends to the document body", () => {
    expect(
      apply({ action: "prepend", text: "HEAD\n" }).startsWith("HEAD\n"),
    ).toBe(true);
    expect(apply({ action: "append", text: "TAIL\n" }).endsWith("TAIL\n")).toBe(
      true,
    );
  });

  it("inserts relative to an unambiguous anchor", () => {
    expect(
      apply({
        action: "insert_after",
        anchor: "# Gamma",
        text: "\n\nINSERTED",
      }),
    ).toContain("# Gamma\n\nINSERTED");
    expect(
      apply({
        action: "insert_before",
        anchor: "Gamma body.",
        text: "BEFORE ",
      }),
    ).toContain("BEFORE Gamma body.");
  });
});

describe("range compilation", () => {
  it("applies independent actions against the original body", () => {
    expect(
      apply(
        { action: "replace_text", find: "token", replace: "T" },
        { action: "replace_text", find: "Gamma body", replace: "G" },
      ),
    ).toBe(
      "# Alpha\n\nAlpha body with T here.\n\n## Beta\n\nBeta body.\n\n# Gamma\n\nG.\n",
    );
  });

  it("rejects overlapping edits and two insertions at one position", () => {
    expect(() =>
      apply(
        { action: "replace_text", find: "Alpha body", replace: "x" },
        { action: "replace_text", find: "body with", replace: "y" },
      ),
    ).toThrow(/overlap or conflict/);
    expect(() =>
      apply({ action: "append", text: "a" }, { action: "append", text: "b" }),
    ).toThrow(/overlap or conflict/);
  });

  it("accepts an empty action list", () => {
    expect(apply()).toBe(MD);
  });
});
