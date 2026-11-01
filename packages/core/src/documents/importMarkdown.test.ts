import { describe, expect, it } from "vitest";
import { composeDocumentFile } from "./frontmatter";
import {
  importedReview,
  importTitle,
  splitImportHeader,
  titleFromFileName,
  withoutTitleHeading,
} from "./importMarkdown";
import { documentTitleSchema } from "./title";

describe("splitImportHeader", () => {
  it("returns the text untouched without a header or leading title heading", () => {
    expect(splitImportHeader("Intro\n\n# Later\n")).toEqual({
      title: null,
      body: "Intro\n\n# Later\n",
    });
  });

  it("takes a leading # heading as the title and removes it from the body", () => {
    expect(splitImportHeader("\n# Hi *there*\n\nBody\n")).toEqual({
      title: "Hi *there*",
      body: "Body\n",
    });
    expect(splitImportHeader("## Section\n\nBody\n")).toEqual({
      title: null,
      body: "## Section\n\nBody\n",
    });
  });

  it("strips a Weaver comment header and reads the title heading", () => {
    const text =
      "<!-- weaver\nid: 11111111-1111-4111-8111-111111111111\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\n-->\n\n# Setup \\*guide\\*\n\nBody\n";
    expect(splitImportHeader(text)).toEqual({
      title: "Setup *guide*",
      body: "Body\n",
    });
  });

  it("keeps a heading that differs from the YAML title in the body", () => {
    expect(
      splitImportHeader("---\ntitle: Front\n---\n\n# Other\n\nBody\n"),
    ).toEqual({ title: "Front", body: "# Other\n\nBody\n" });
    expect(
      splitImportHeader("---\ntitle: Same\n---\n\n# Same\n\nBody\n"),
    ).toEqual({ title: "Same", body: "Body\n" });
  });

  it("strips a Weaver frontmatter block and reads its quoted title", () => {
    const text =
      '---\nid: 11111111-1111-4111-8111-111111111111\ntitle: "Setup guide"\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\n---\n\nBody\n';
    expect(splitImportHeader(text)).toEqual({
      title: "Setup guide",
      body: "Body\n",
    });
  });

  it("reads a bare title and drops other keys", () => {
    expect(
      splitImportHeader("---\ntags: [a, b]\ntitle: Plain title\n---\nBody"),
    ).toEqual({ title: "Plain title", body: "Body" });
  });

  it("ignores a frontmatter-looking block that never closes", () => {
    expect(splitImportHeader("---\ntitle: x\nBody")).toEqual({
      title: null,
      body: "---\ntitle: x\nBody",
    });
  });
});

describe("titleFromFileName", () => {
  it("strips the extension and path and humanizes separators", () => {
    expect(titleFromFileName("notes/my_setup-guide.md")).toBe("My setup guide");
  });
  it("falls back for empty stems", () => {
    expect(titleFromFileName(".md")).toBe("Untitled import");
  });
});

describe("importTitle", () => {
  it("prefers the frontmatter title, then a leading heading, then the file name", () => {
    expect(importTitle("---\ntitle: From front\n---\n", "file.md")).toBe(
      "From front",
    );
    expect(importTitle("# Heading\n", "file-name.md")).toBe("Heading");
    expect(importTitle("Plain text\n", "file-name.md")).toBe("File name");
  });
  it("caps titles at 200 characters and collapses line terminators", () => {
    const long = "x".repeat(300);
    expect(importTitle(`---\ntitle: ${long}\n---\n`, "a.md")).toHaveLength(200);
  });
  it("sanitizes JSON-escaped paragraph separators from a quoted frontmatter title", () => {
    const title = importTitle(
      '---\ntitle: "para one\\u2028para two"\n---\n',
      "a.md",
    );
    expect(title).toBe("para one para two");
    expect(documentTitleSchema.safeParse(title).success).toBe(true);
  });
  it("replaces a NUL byte in a bare frontmatter title with a space", () => {
    const title = importTitle("---\ntitle: bare\u0000title\n---\n", "a.md");
    expect(title).toBe("bare title");
  });
});

describe("importedReview", () => {
  it("reads the review block of a Weaver file and nothing else", () => {
    const review = {
      reviewers: [],
      everyMonths: 6,
      since: "2026-01-01T00:00:00.000Z",
      lastReviewed: null,
      reviewedBy: null,
    };
    const file = composeDocumentFile(
      {
        id: "00000000-0000-4000-8000-000000000001",
        title: "T",
        created: "2026-01-01T00:00:00.000Z",
        createdBy: null,
        updated: "2026-01-01T00:00:00.000Z",
        updatedBy: null,
        review,
      },
      "Body\n",
      "markdown",
    );
    expect(importedReview(file)).toEqual(review);
    expect(importedReview(file.replace(/\n/g, "\r\n"))).toEqual(review);
    expect(importedReview("# Plain\n\nText\n")).toBeNull();
    expect(importedReview("---\ntitle: X\n---\n\nText\n")).toBeNull();
  });
});

describe("withoutTitleHeading", () => {
  it("drops a leading heading that repeats the title", () => {
    expect(withoutTitleHeading("# Plan\n\nBody\n", "Plan")).toBe("Body\n");
    expect(withoutTitleHeading("\n# Hi \\*there\\*\nBody", "Hi *there*")).toBe(
      "Body",
    );
    expect(withoutTitleHeading("# Plan", "Plan")).toBe("");
  });

  it("keeps any other opening", () => {
    for (const body of [
      "# Other\n\nBody\n",
      "## Plan\n\nBody\n",
      "Plan\n\n# Plan\n",
    ])
      expect(withoutTitleHeading(body, "Plan")).toBe(body);
  });
});
