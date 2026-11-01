import { describe, expect, it } from "vitest";

import { MAX_KNOWLEDGE_CHUNKS, chunkMarkdown, contentHash } from "./chunking";

describe("chunkMarkdown", () => {
  it("is deterministic and carries heading paths", () => {
    const markdown =
      "# Runbook\nIntro.\n\n## Deploy\n```sh\npnpm build\n```\nDone.";
    const first = chunkMarkdown({
      documentId: "11111111-1111-4111-8111-111111111111",
      sourceCommitSha: "a".repeat(40),
      title: "Runbook",
      markdown,
      maxChars: 80,
      overlapChars: 10,
    });

    expect(
      chunkMarkdown({
        documentId: "11111111-1111-4111-8111-111111111111",
        sourceCommitSha: "a".repeat(40),
        title: "Runbook",
        markdown,
        maxChars: 80,
        overlapChars: 10,
      }),
    ).toEqual(first);
    expect(
      first.some(
        (chunk) => chunk.headingPath.join(" / ") === "Runbook / Deploy",
      ),
    ).toBe(true);
    expect(
      first.map((chunk) => chunk.id).every((id) => /^[a-f0-9]{64}$/.test(id)),
    ).toBe(true);
    expect(first.map((chunk) => chunk.content).join("\n")).toContain(
      "pnpm build",
    );
  });

  it("normalizes line endings, keeps fenced blocks intact, and overlaps plain text", () => {
    const chunks = chunkMarkdown({
      documentId: "11111111-1111-4111-8111-111111111111",
      sourceCommitSha: "b".repeat(40),
      title: "Notes",
      markdown:
        "# Notes\r\nfirst plain paragraph\r\n\r\n```txt\r\nline one\r\nline two\r\n```\r\n\r\nsecond plain paragraph",
      maxChars: 35,
      overlapChars: 8,
    });

    expect(
      chunks.some((chunk) =>
        chunk.content.includes("```txt\nline one\nline two\n```"),
      ),
    ).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes("\r"))).toBe(false);
    expect(chunks[1]?.content.startsWith("graph")).toBe(true);
    expect(chunks.every((chunk) => chunk.content.length <= 35)).toBe(true);
  });

  it("moves a fitting paragraph to the next chunk instead of splitting it", () => {
    const chunks = chunkMarkdown({
      documentId: "11111111-1111-4111-8111-111111111111",
      sourceCommitSha: "c".repeat(40),
      title: "Notes",
      markdown: `${"a".repeat(30)}\n\n${"b".repeat(10)}`,
      maxChars: 35,
      overlapChars: 0,
    });

    expect(chunks.map((chunk) => chunk.content)).toEqual([
      "a".repeat(30),
      "b".repeat(10),
    ]);
  });

  it("caps overlap to the room available for the next plain paragraph", () => {
    const chunks = chunkMarkdown({
      documentId: "11111111-1111-4111-8111-111111111111",
      sourceCommitSha: "d".repeat(40),
      title: "Notes",
      markdown: "abcdefghij\n\nklmnop",
      maxChars: 10,
      overlapChars: 8,
    });

    expect(chunks.map((chunk) => chunk.content)).toEqual([
      "abcdefghij",
      "ij\n\nklmnop",
    ]);
    expect(chunks.every((chunk) => chunk.content.length <= 10)).toBe(true);
  });

  it("attaches overlap to oversized paragraph content without emitting overlap-only chunks", () => {
    const chunks = chunkMarkdown({
      documentId: "11111111-1111-4111-8111-111111111111",
      sourceCommitSha: "e".repeat(40),
      title: "Notes",
      markdown: `abcdefghij\n\n${"k".repeat(20)}`,
      maxChars: 10,
      overlapChars: 8,
    });

    expect(chunks.every((chunk) => chunk.content.length <= 10)).toBe(true);
    expect(chunks.slice(1).every((chunk) => chunk.content.includes("k"))).toBe(
      true,
    );
    expect(chunks[1]?.content).toMatch(/^defghij\n\nk$/);
  });

  it("splits an oversized fenced block without exceeding the hard chunk limit", () => {
    const chunks = chunkMarkdown({
      documentId: "11111111-1111-4111-8111-111111111111",
      sourceCommitSha: "f".repeat(40),
      title: "Notes",
      markdown: "```txt\n123456789\n```",
      maxChars: 10,
      overlapChars: 8,
    });

    expect(chunks.map((chunk) => chunk.content).join("")).toBe(
      "```txt\n123456789\n```",
    );
    expect(chunks.every((chunk) => chunk.content.length <= 10)).toBe(true);
  });

  it("rejects input that would emit more than the maximum chunk count", () => {
    const maximum = chunkMarkdown({
      documentId: "11111111-1111-4111-8111-111111111111",
      sourceCommitSha: "f".repeat(40),
      title: "Notes",
      markdown: "x".repeat(MAX_KNOWLEDGE_CHUNKS),
      maxChars: 1,
      overlapChars: 0,
    });

    expect(maximum).toHaveLength(MAX_KNOWLEDGE_CHUNKS);
    expect(() =>
      chunkMarkdown({
        documentId: "11111111-1111-4111-8111-111111111111",
        sourceCommitSha: "f".repeat(40),
        title: "Notes",
        markdown: "x".repeat(MAX_KNOWLEDGE_CHUNKS + 1),
        maxChars: 1,
        overlapChars: 0,
      }),
    ).toThrow("Markdown exceeds the maximum knowledge chunk count");
  });

  it("bounds heading depth and component length at ingestion", () => {
    const chunks = chunkMarkdown({
      documentId: "11111111-1111-4111-8111-111111111111",
      sourceCommitSha: "f".repeat(40),
      title: "t".repeat(300),
      markdown: `${Array.from(
        { length: 6 },
        (_, index) => `${"#".repeat(index + 1)} ${"h".repeat(300)}`,
      ).join("\n")}\ncontent`,
      maxChars: 1_000,
      overlapChars: 0,
    });

    expect(chunks.at(-1)?.headingPath).toHaveLength(6);
    expect(
      chunks.every((chunk) =>
        chunk.headingPath.every((heading) => heading.length <= 200),
      ),
    ).toBe(true);
  });

  it("assigns title-independent anchors to distinct document sections", () => {
    const markdown = [
      "Preamble",
      "",
      "## Deploy",
      "First section",
      "",
      "## Deploy",
      "Second section",
    ].join("\n");
    const chunks = chunkMarkdown({
      documentId: "document-1",
      sourceCommitSha: "a".repeat(40),
      title: "Renamed title",
      markdown,
      maxChars: 100,
      overlapChars: 0,
    });

    expect(chunks.map((chunk) => chunk.navigationAnchor)).toEqual([
      null,
      "section-deploy",
      "section-deploy-2",
    ]);
    expect(chunks[1]?.headingPath).toEqual(["Renamed title", "Deploy"]);
    expect(
      chunkMarkdown({
        documentId: "document-1",
        sourceCommitSha: "a".repeat(40),
        title: "Different title",
        markdown,
        maxChars: 100,
        overlapChars: 0,
      })
        .map((chunk) => chunk.navigationAnchor)
        .filter((anchor): anchor is string => anchor !== null),
    ).toEqual(["section-deploy", "section-deploy-2"]);
  });

  it("keeps a section anchor on every chunk that splits its content", () => {
    const chunks = chunkMarkdown({
      documentId: "document-1",
      sourceCommitSha: "a".repeat(40),
      title: "Runbook",
      markdown: `## Deploy\n${"x".repeat(25)}`,
      maxChars: 10,
      overlapChars: 0,
    });

    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.navigationAnchor)).toEqual([
      "section-deploy",
      "section-deploy",
      "section-deploy",
    ]);
  });
});

describe("contentHash", () => {
  it("uses SHA-256", () => {
    expect(contentHash("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

it.each([
  "# Overview\nBody",
  "Preamble\n\n# Overview\nBody\n\n## Details\nMore",
  "### Details\nBody",
])("preserves the document title with headings in %j", (markdown) => {
  const chunks = chunkMarkdown({
    documentId: "doc",
    sourceCommitSha: "a".repeat(40),
    title: "Quarterly Budget",
    markdown,
    maxChars: 9000,
    overlapChars: 0,
  });
  expect(chunks.length).toBeGreaterThan(0);
  expect(
    chunks.every((chunk) => chunk.headingPath[0] === "Quarterly Budget"),
  ).toBe(true);
});

describe("empty sections", () => {
  it("indexes heading-only documents and trailing headings with their anchors", () => {
    const input = {
      documentId: "example",
      sourceCommitSha: "a".repeat(40),
      title: "Outline",
      maxChars: 9000,
      overlapChars: 0,
    };
    const headings = chunkMarkdown({
      ...input,
      markdown: "# Zebra\n\n## Xylophone",
    });
    expect(headings.map((chunk) => chunk.content).join("\n")).toContain(
      "Xylophone",
    );
    expect(
      headings.some(
        (chunk) => chunk.navigationAnchor === "section-zebra--xylophone",
      ),
    ).toBe(true);
    const trailing = chunkMarkdown({
      ...input,
      markdown: "# Zebra\n\nBody text\n\n## Xylophone",
    });
    expect(trailing.map((chunk) => chunk.content).join("\n")).toContain(
      "Xylophone",
    );
  });

  it("indexes an image line as it is written, in either form", () => {
    const content = (markdown: string) =>
      chunkMarkdown({
        documentId: "11111111-1111-4111-8111-111111111111",
        sourceCommitSha: "a".repeat(40),
        title: "Guide",
        markdown,
        maxChars: 400,
        overlapChars: 0,
      })
        .map((chunk) => chunk.content)
        .join("\n");

    expect(content("Intro.\n\n![Login dialog](guide.assets/shot.png)\n")).toBe(
      "Intro.\n\n![Login dialog](guide.assets/shot.png)",
    );
    expect(
      content(
        'Intro.\n\n<img src="guide.assets/shot.png" alt="Login dialog" width="400">\n',
      ),
    ).toBe(
      'Intro.\n\n<img src="guide.assets/shot.png" alt="Login dialog" width="400">',
    );
  });
});
