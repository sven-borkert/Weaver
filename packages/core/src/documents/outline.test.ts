import { describe, expect, it } from "vitest";
import { parseDocumentBody, serializeDocumentBody } from "../editor/markdown";
import { documentOutline, documentOutlineFor, findSection } from "./outline";

const MD = [
  "Preamble text.",
  "",
  "# Alpha",
  "",
  "Alpha body.",
  "",
  "## Beta",
  "",
  "Beta body.",
  "",
  "# Gamma",
  "",
  "```",
  "# not a heading",
  "```",
  "",
  "Gamma body.",
  "",
].join("\n");

describe("documentOutline", () => {
  it("returns headings with depth, anchor ids, and descendant-inclusive extents", () => {
    const sections = documentOutline(MD);
    expect(sections.map((s) => [s.heading, s.depth, s.id])).toEqual([
      ["Alpha", 1, "section-alpha"],
      ["Beta", 2, "section-alpha--beta"],
      ["Gamma", 1, "section-gamma"],
    ]);

    const [alpha, beta, gamma] = sections;
    // Alpha runs to Gamma because its extent includes the Beta subtree.
    expect(MD.slice(alpha!.start, alpha!.end)).toContain("## Beta");
    expect(MD.slice(alpha!.start, alpha!.end)).not.toContain("# Gamma");
    expect(MD.slice(alpha!.start, alpha!.bodyStart)).toBe("# Alpha\n");
    expect(MD.slice(beta!.bodyStart, beta!.end).trim()).toBe("Beta body.");
    expect(gamma!.end).toBe(MD.length);
  });

  it("ignores a heading-like line inside a fenced block", () => {
    expect(documentOutline(MD).some((s) => s.heading === "not a heading")).toBe(
      false,
    );
  });

  it("allocates distinct ids for repeated headings", () => {
    const sections = documentOutline("# Same\n\na\n\n# Same\n\nb\n");
    expect(sections.map((s) => s.id)).toEqual([
      "section-same",
      "section-same-2",
    ]);
  });

  it("returns an empty outline for a document with no headings", () => {
    expect(documentOutline("Just a paragraph.\n")).toEqual([]);
  });

  it("finds a section by id and returns null otherwise", () => {
    const sections = documentOutline(MD);
    expect(findSection(sections, "section-gamma")?.heading).toBe("Gamma");
    expect(findSection(sections, "section-missing")).toBeNull();
  });

  it("matches the headings the Markdown parser sees", () => {
    // Guards the line-scanning approach: the outline must agree with the
    // parsed node tree for canonical serializer output.
    const canonical = serializeDocumentBody(parseDocumentBody(MD));
    const parsed = parseDocumentBody(canonical);
    const parsedHeadings = (parsed.content ?? [])
      .filter((node) => node.type === "heading")
      .map((node) => ({
        depth: Number(node.attrs?.level),
        text: (node.content ?? []).map((c) => c.text ?? "").join(""),
      }));
    expect(
      documentOutline(canonical).map((s) => ({
        depth: s.depth,
        text: s.heading,
      })),
    ).toEqual(parsedHeadings);
  });

  it("handles a document ending with a heading without a final newline", () => {
    const doc = "# Final";
    const sections = documentOutline(doc);
    expect(sections).toHaveLength(1);
    const [final] = sections;
    expect(final!.heading).toBe("Final");
    expect(final!.bodyStart).toBe(doc.length);
    expect(final!.end).toBe(doc.length);
  });

  it("produces same headings and offsets for CRLF as LF input", () => {
    const lfDoc = "# Alpha\n\nAlpha body.\n\n# Beta\n\nBeta body.\n";
    const crlfDoc = lfDoc.replace(/\n/g, "\r\n");
    const lfSections = documentOutline(lfDoc);
    const crlfSections = documentOutline(crlfDoc);
    expect(crlfSections.map((s) => [s.heading, s.depth, s.id])).toEqual(
      lfSections.map((s) => [s.heading, s.depth, s.id]),
    );
    expect(
      crlfDoc.slice(crlfSections[0]!.start, crlfSections[0]!.bodyStart),
    ).toBe("# Alpha\r\n");
    expect(
      crlfDoc.slice(crlfSections[1]!.bodyStart, crlfSections[1]!.end).trim(),
    ).toBe("Beta body.");
  });
});

describe("pythonOutline", () => {
  it("maps definitions to sections with stable ids", () => {
    const src = "import x\n\n@d\ndef a():\n    pass\n\nclass B:\n    pass\n";
    const sections = documentOutlineFor("python", src);
    expect(
      sections.map((s) => [s.id, s.heading, src.slice(s.start, s.end)]),
    ).toEqual([
      ["python:def:a:0", "def a", "@d\ndef a():\n    pass\n\n"],
      ["python:class:B:1", "class B", "class B:\n    pass\n"],
    ]);
    expect(src.slice(sections[0]!.bodyStart, sections[0]!.end)).toBe(
      "    pass\n\n",
    );
  });
  it("starts the body after a multi-line signature", () => {
    const src = "def a(\n    x,\n):\n    pass\n";
    const [section] = documentOutlineFor("python", src);
    expect(src.slice(section!.bodyStart, section!.end)).toBe("    pass\n");
  });
  it("ends a section before following module code", () => {
    const src = "def main():\n    pass\n\nX = 1\n";
    const [section] = documentOutlineFor("python", src);
    expect(section!.end).toBe(22);
    expect(src.slice(section!.start, section!.end)).toBe(
      "def main():\n    pass\n\n",
    );
  });
});
