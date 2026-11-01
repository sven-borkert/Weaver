import { describe, expect, it } from "vitest";
import { parseDocumentBody } from "../editor/markdown";
import {
  MAX_LINK_QUERY_CHARS,
  headingsOf,
  linkQueryFor,
  scoreLinkCandidates,
  proposedLinksSchema,
  withRelatedLinks,
  type ProposedLink,
} from "./links";

import {
  MAX_DOCUMENT_SECTION_ANCHOR_CHARACTERS,
  projectDocumentSectionAnchors,
} from "../knowledge/sectionAnchors";

const DOC_A = "11111111-1111-4111-8111-111111111111";
const DOC_B = "22222222-2222-4222-8222-222222222222";

function link(overrides: Partial<ProposedLink>): ProposedLink {
  return {
    documentId: DOC_A,
    title: "Setup guide",
    anchor: null,
    confidence: 0.9,
    excerpt: "",
    keep: true,
    ...overrides,
  };
}

describe("linkQueryFor", () => {
  it("joins distinct significant words with or", () => {
    expect(linkQueryFor("Quarterly Revenue: the revenue plan, v2")).toBe(
      "quarterly or revenue or plan",
    );
  });
  it("returns null when no word is long enough", () => {
    expect(linkQueryFor("a b c")).toBeNull();
  });

  it("skips an oversized word and returns null when no complete word fits", () => {
    const oversized = "x".repeat(MAX_LINK_QUERY_CHARS + 1);
    expect(linkQueryFor(oversized)).toBeNull();
    expect(linkQueryFor(`${oversized} usable`)).toBe("usable");
  });

  it("accounts for or separators without splitting the last fitting word", () => {
    const words = Array.from(
      { length: 12 },
      (_, index) => `token${String(index).padStart(4, "0")}`,
    );
    const query = linkQueryFor(words.join(" "));
    expect(query).toBe(words.slice(0, 9).join(" or "));
    expect(query?.length).toBeLessThanOrEqual(MAX_LINK_QUERY_CHARS);
  });
});

describe("headingsOf", () => {
  it("returns the first three level-1 to level-3 headings", () => {
    expect(
      headingsOf("# One\ntext\n## Two ##\n#### Four\n### Three\n## Five"),
    ).toEqual(["One", "Two", "Three"]);
  });
});

describe("scoreLinkCandidates", () => {
  it.each([3, 4])(
    "preserves canonical Unicode anchors from %s nested headings",
    (depth) => {
      const heading = "𐐀".repeat(48);
      const markdown = Array.from(
        { length: depth },
        (_, index) => `${"#".repeat(index + 1)} ${heading}`,
      ).join("\n");
      const anchor = projectDocumentSectionAnchors(markdown).at(-1)!.anchor;
      expect(anchor.length).toBeGreaterThan(200);
      expect(Array.from(anchor).length).toBeLessThanOrEqual(
        MAX_DOCUMENT_SECTION_ANCHOR_CHARACTERS,
      );
      const links = scoreLinkCandidates(
        [
          [
            {
              documentId: DOC_A,
              title: "Unicode",
              navigationAnchor: anchor,
              content: "Matching body",
              rank: 1,
            },
          ],
        ],
        ["Unicode"],
      );
      expect(proposedLinksSchema.parse(links)[0]?.anchor).toBe(anchor);
    },
  );

  it("rejects anchors exceeding the canonical code-point bound without changing their identity", () => {
    for (const anchor of ["a", "𐐀"].map((letter) =>
      letter.repeat(MAX_DOCUMENT_SECTION_ANCHOR_CHARACTERS + 1),
    )) {
      expect(proposedLinksSchema.safeParse([link({ anchor })]).success).toBe(
        false,
      );
    }
  });

  it("scores exact matches at 1, scales others by rank, and keeps the best per document", () => {
    const links = scoreLinkCandidates([
      [
        {
          documentId: DOC_A,
          title: "Exact",
          navigationAnchor: null,
          content: "x",
          rank: 0,
        },
        {
          documentId: DOC_B,
          title: "Partial",
          navigationAnchor: "s-1",
          content: "  body  text ",
          rank: 0.2,
        },
      ],
      [
        {
          documentId: DOC_B,
          title: "Partial",
          navigationAnchor: null,
          content: "y",
          rank: 0.1,
        },
      ],
    ]);
    expect(links).toEqual([
      expect.objectContaining({ documentId: DOC_A, confidence: 1, keep: true }),
      expect.objectContaining({
        documentId: DOC_B,
        confidence: 0.95,
        anchor: "s-1",
        excerpt: "body text",
        keep: true,
      }),
    ]);
  });
  it("marks weak matches as not kept and caps the list at ten", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      documentId: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
      title: `Doc ${i}`,
      navigationAnchor: null,
      content: "",
      rank: 0.01 * (i + 1),
    }));
    const links = scoreLinkCandidates([many]);
    expect(links).toHaveLength(10);
    expect(links.at(-1)?.keep).toBe(false);
  });

  it("does not treat an arbitrary rank-zero result as exact when a source title is supplied", () => {
    const [partial] = scoreLinkCandidates(
      [
        [
          {
            documentId: DOC_A,
            title: "Setup notes",
            navigationAnchor: null,
            content: "setup",
            rank: 0,
          },
        ],
      ],
      ["Setup Guide"],
    );
    expect(partial).toMatchObject({ confidence: 0.4, keep: false });
  });
});

describe("withRelatedLinks", () => {
  it("appends kept links as crossrefs the document parser recognizes", () => {
    const markdown = withRelatedLinks("# Title\n\nBody.\n", [
      link({ title: "Setup [Guide]" }),
      link({ documentId: DOC_B, keep: false }),
    ]);
    expect(markdown).toBe(
      `# Title\n\nBody.\n\n## Related\n\n- [Setup \\[Guide\\]](weaver://document/${DOC_A})\n`,
    );
    const json = JSON.stringify(parseDocumentBody(markdown));
    expect(json).toContain(`"targetId":"${DOC_A}"`);
    expect(json).not.toContain(DOC_B);
  });
  it("returns the markdown unchanged without kept links", () => {
    expect(withRelatedLinks("Body\n", [link({ keep: false })])).toBe("Body\n");
  });
});
