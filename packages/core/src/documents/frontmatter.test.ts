import { describe, expect, it } from "vitest";
import {
  FrontmatterError,
  MAX_AUTHOR_NAME_CHARS,
  assertAuthorName,
  authorForUser,
  composeDocumentFile,
  composeTitleHeading,
  parseDocumentFile,
  parseTitleHeading,
} from "./frontmatter";

const meta = {
  id: "6f1f39d4-3f6a-4b7e-9a80-0a4c3a3f1b2c",
  title: 'He said: "42" — ok',
  created: "2026-08-27T10:00:00.000Z",
  createdBy: null,
  updated: "2026-08-27T11:30:00.000Z",
  updatedBy: null,
  review: null,
};
const authored = {
  ...meta,
  createdBy: {
    id: "0b0e7c1a-5a4e-4a8e-9b1f-2c3d4e5f6a7b",
    name: "Ada Lovelace",
  },
  updatedBy: { id: null, name: 'Sven "Ops" Borkert' },
};

/** A file as Weaver wrote it before header version 2. */
function yamlFile(values: typeof meta, body: string): string {
  return (
    `---\nid: ${values.id}\ntitle: ${JSON.stringify(values.title)}\n` +
    `created: ${values.created}\nupdated: ${values.updated}\n---\n\n${body}`
  );
}

describe("document header", () => {
  it("roundtrips_legacy_and_styled_document_folder_table", () => {
    expect(
      parseDocumentFile(yamlFile(meta, "Old body\n"), "markdown").meta,
    ).not.toHaveProperty("appearance");
    expect(
      parseDocumentFile(
        composeDocumentFile(meta, "Body\n", "markdown"),
        "markdown",
      ).meta,
    ).not.toHaveProperty("appearance");
    const styled = {
      ...authored,
      updatedBy: { id: null, name: "Evil --> author" },
      review: {
        reviewers: [],
        everyMonths: 12,
        since: meta.created,
        lastReviewed: null,
        reviewedBy: null,
      },
      appearance: {
        backgroundColor: "#AABBCC",
        icon: { type: "emoji" as const, value: "👨‍👩‍👧‍👦" },
      },
    };
    const file = composeDocumentFile(styled, "Body **text**\n", "markdown");
    expect(file).toContain(
      'appearance: {"backgroundColor":"#aabbcc","icon":{"type":"emoji","value":"👨‍👩‍👧‍👦"}}\n',
    );
    expect(file.indexOf("-->")).toBe(file.lastIndexOf("-->"));
    expect(file).toContain("Evil --\\u003e author");
    const parsed = parseDocumentFile(file, "markdown");
    expect(parsed).toEqual({
      meta: {
        ...styled,
        appearance: { ...styled.appearance, backgroundColor: "#aabbcc" },
      },
      body: "Body **text**\n",
      legacy: false,
    });
    expect(composeDocumentFile(parsed.meta, parsed.body, "markdown")).toBe(
      file,
    );
  });
  it("drops_bad_optional_appearance_without_dropping_content", () => {
    const base = composeDocumentFile(authored, "Body\n", "markdown");
    for (const raw of [
      '{"backgroundColor":"red","icon":{"type":"emoji","value":"😀😀"}}',
      "not json",
      "[]",
    ]) {
      expect(
        parseDocumentFile(
          base.replace("-->\n", `appearance: ${raw}\n-->\n`),
          "markdown",
        ),
      ).toEqual({ meta: authored, body: "Body\n", legacy: false });
    }
    expect(
      composeDocumentFile({ ...meta, appearance: {} }, "Body\n", "markdown"),
    ).toBe(composeDocumentFile(meta, "Body\n", "markdown"));
  });

  it("hides the metadata in a comment and shows the title as the first heading", () => {
    expect(composeDocumentFile(authored, "Hello\n", "markdown")).toBe(
      `<!-- weaver\n` +
        `id: ${meta.id}\n` +
        `created: ${meta.created}\n` +
        `createdBy: {"id":"0b0e7c1a-5a4e-4a8e-9b1f-2c3d4e5f6a7b","name":"Ada Lovelace"}\n` +
        `updated: ${meta.updated}\n` +
        `updatedBy: {"id":null,"name":"Sven \\"Ops\\" Borkert"}\n` +
        `-->\n\n` +
        `# He said: "42" — ok\n\n` +
        `Hello\n`,
    );
  });
  it("round-trips compose -> parse byte-exactly", () => {
    for (const values of [meta, authored]) {
      const file = composeDocumentFile(values, "Body **text**\n", "markdown");
      const parsed = parseDocumentFile(file, "markdown");
      expect(parsed).toEqual({
        meta: values,
        body: "Body **text**\n",
        legacy: false,
      });
      expect(composeDocumentFile(parsed.meta, parsed.body, "markdown")).toBe(
        file,
      );
    }
  });
  it("keeps a body that starts with its own heading", () => {
    const parsed = parseDocumentFile(
      composeDocumentFile(meta, "# Notes\n\nFirst.\n", "markdown"),
      "markdown",
    );
    expect(parsed.meta.title).toBe(meta.title);
    expect(parsed.body).toBe("# Notes\n\nFirst.\n");
  });
  it("round-trips an empty body", () => {
    const parsed = parseDocumentFile(
      composeDocumentFile(meta, "", "markdown"),
      "markdown",
    );
    expect(parsed.body).toBe("\n");
  });
  it("never lets an author name close the comment early", () => {
    const file = composeDocumentFile(
      { ...authored, createdBy: { id: null, name: "Evil --> <b>" } },
      "Body\n",
      "markdown",
    );
    expect(file.indexOf("-->")).toBe(file.lastIndexOf("-->"));
    expect(parseDocumentFile(file, "markdown").meta.createdBy).toEqual({
      id: null,
      name: "Evil --> <b>",
    });
  });
  it("reads files written as YAML frontmatter and marks them legacy", () => {
    const parsed = parseDocumentFile(yamlFile(meta, "Old body\n"), "markdown");
    expect(parsed).toEqual({ meta, body: "Old body\n", legacy: true });
  });
  it("requires the leading title heading", () => {
    const file = composeDocumentFile(meta, "Body\n", "markdown").replace(
      /# He said.*\n\n/,
      "",
    );
    expect(() => parseDocumentFile(file, "markdown")).toThrow(FrontmatterError);
  });
  it("rejects non-canonical or invalid authors", () => {
    const base = composeDocumentFile(authored, "Body\n", "markdown");
    for (const bad of [
      '{"name":"Ada Lovelace","id":"0b0e7c1a-5a4e-4a8e-9b1f-2c3d4e5f6a7b"}',
      '{"id":"0b0e7c1a-5a4e-4a8e-9b1f-2c3d4e5f6a7b", "name":"Ada Lovelace"}',
      '{"id":"not-a-uuid","name":"Ada"}',
      '{"id":null,"name":""}',
      '{"id":null,"name":" padded"}',
      '{"id":null}',
    ]) {
      expect(() =>
        parseDocumentFile(
          base.replace(/createdBy: .*\n/, `createdBy: ${bad}\n`),
          "markdown",
        ),
      ).toThrow(FrontmatterError);
    }
    expect(() =>
      composeDocumentFile(
        { ...authored, createdBy: { id: null, name: "Two\nlines" } },
        "Body\n",
        "markdown",
      ),
    ).toThrow(FrontmatterError);
  });
  it("ensures a trailing newline on the body", () => {
    expect(composeDocumentFile(meta, "x", "markdown").endsWith("x\n")).toBe(
      true,
    );
  });
  it("rejects malformed UUIDs when composing", () => {
    for (const id of ["not-a-uuid", meta.id.toUpperCase()]) {
      expect(() =>
        composeDocumentFile({ ...meta, id }, "Body\n", "markdown"),
      ).toThrow(FrontmatterError);
    }
  });
  it("throws FrontmatterError on malformed input", () => {
    for (const bad of [
      "no header",
      "---\nid: nope\n---\n",
      "<!-- weaver\nid: nope\n-->\n",
      "",
    ]) {
      expect(() => parseDocumentFile(bad, "markdown")).toThrow(
        FrontmatterError,
      );
    }
  });
  it.each(["2026-02-30T10:00:00.000Z", "2026-08-27T10:00:00+00:00"])(
    "rejects the non-canonical timestamp %s",
    (timestamp) => {
      for (const field of ["created", "updated"] as const) {
        const invalid = { ...meta, [field]: timestamp };
        expect(() =>
          composeDocumentFile(invalid, "Body\n", "markdown"),
        ).toThrow(FrontmatterError);
        expect(() =>
          parseDocumentFile(yamlFile(invalid, "Body\n"), "markdown"),
        ).toThrow(FrontmatterError);
        expect(() =>
          parseDocumentFile(
            composeDocumentFile(meta, "Body\n", "markdown").replace(
              `${field}: ${meta[field]}`,
              `${field}: ${timestamp}`,
            ),
            "markdown",
          ),
        ).toThrow(FrontmatterError);
      }
    },
  );
});

describe("title heading", () => {
  it.each([
    "Plain title",
    "12.03.2020 - Truncate alert tables",
    "Use *emphasis* and _underscores_",
    "Links [like](this) and ![images](x)",
    "Code `inline` and <html> & entities &amp;",
    "Strike ~~this~~ and back\\slash",
    "Ends with #",
    "C#",
    "#hashtag start",
    "Issue # 42 ##",
  ])("round-trips %j through a # heading", (title) => {
    const heading = composeTitleHeading(title);
    expect(heading.startsWith("# ")).toBe(true);
    expect(parseTitleHeading(heading)).toBe(title);
  });
  it("escapes an ampersand only where it would start an entity", () => {
    expect(composeTitleHeading("Platform & Operations")).toBe(
      "# Platform & Operations",
    );
    expect(composeTitleHeading("The &copy; sign")).toBe("# The \\&copy; sign");
    expect(parseTitleHeading("# The \\&copy; sign")).toBe("The &copy; sign");
  });
  it("reads headings written by other editors", () => {
    expect(parseTitleHeading("# Closing sequence ##")).toBe("Closing sequence");
    expect(parseTitleHeading("   #  Indented  ")).toBe("Indented");
    expect(parseTitleHeading("## Level two")).toBeNull();
    expect(parseTitleHeading("#no space")).toBeNull();
    expect(parseTitleHeading("# ")).toBeNull();
  });
});

it.each(["\u2028", "\u2029"])(
  "can recover a stored unicode separator %s in a title",
  (separator) => {
    const legacyMeta = { ...meta, title: `before${separator}after` };
    expect(
      parseDocumentFile(
        composeDocumentFile(legacyMeta, "body", "markdown"),
        "markdown",
      ).meta,
    ).toEqual(legacyMeta);
    expect(
      parseDocumentFile(yamlFile(legacyMeta, "body"), "markdown").meta,
    ).toEqual(legacyMeta);
  },
);

describe("authorForUser", () => {
  const id = "6f1f39d4-3f6a-4b7e-9a80-0a4c3a3f1b2c";

  it("uses the display name, collapsed to one line", () => {
    expect(
      authorForUser({
        id,
        name: " Ada \n Lovelace ",
        email: "ada@example.com",
      }),
    ).toEqual({ id, name: "Ada Lovelace" });
  });

  it("falls back to the email normalised like a name", () => {
    const author = authorForUser({
      id,
      name: "  ",
      email: `${"a".repeat(250)}@example.com`,
    });
    expect([...author.name].length).toBe(MAX_AUTHOR_NAME_CHARS);
    expect(() => assertAuthorName(author.name)).not.toThrow();
  });

  it("keeps an email with a control character usable as a name", () => {
    const author = authorForUser({
      id,
      name: null,
      email: "a\u0000b@example.com",
    });
    expect(author).toEqual({ id, name: "a b@example.com" });
    expect(() => assertAuthorName(author.name)).not.toThrow();
  });
});

const REVIEW = {
  reviewers: [
    {
      type: "group" as const,
      id: "00000000-0000-4000-8000-0000000000aa",
      name: "Ops > Net",
    },
    {
      type: "user" as const,
      id: "00000000-0000-4000-8000-0000000000bb",
      name: "Ada",
    },
  ],
  everyMonths: 12,
  since: "2026-10-07T09:00:00.000Z",
  lastReviewed: "2026-11-02T14:10:00.000Z",
  reviewedBy: { id: "00000000-0000-4000-8000-0000000000bb", name: "Ada" },
};
const REVIEW_META = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "Doc",
  created: "2026-10-01T00:00:00.000Z",
  createdBy: { id: null, name: "Ada" },
  updated: "2026-10-01T00:00:00.000Z",
  updatedBy: { id: null, name: "Ada" },
};

describe("review header", () => {
  it("round-trips a reviewed document byte-exactly", () => {
    const file = composeDocumentFile(
      { ...REVIEW_META, review: REVIEW },
      "Body\n",
      "markdown",
    );
    expect(file).toContain(
      'reviewEvery: 12\nreviewSince: 2026-10-07T09:00:00.000Z\nlastReviewed: 2026-11-02T14:10:00.000Z\nreviewedBy: {"id":"00000000-0000-4000-8000-0000000000bb","name":"Ada"}\n-->',
    );
    expect(file).toContain("Ops \\u003e Net");
    const parsed = parseDocumentFile(file, "markdown");
    expect(parsed.meta.review).toEqual(REVIEW);
    expect(composeDocumentFile(parsed.meta, parsed.body, "markdown")).toBe(
      file,
    );
  });
  it("omits lastReviewed and reviewedBy before the first review", () => {
    const review = { ...REVIEW, lastReviewed: null, reviewedBy: null };
    const file = composeDocumentFile(
      { ...REVIEW_META, review },
      "Body\n",
      "markdown",
    );
    expect(file).not.toContain("lastReviewed");
    const parsed = parseDocumentFile(file, "markdown");
    expect(parsed.meta.review).toEqual(review);
    expect(composeDocumentFile(parsed.meta, parsed.body, "markdown")).toBe(
      file,
    );
  });
  it("reads a header without review lines as review null", () => {
    const file = composeDocumentFile(
      { ...REVIEW_META, review: null },
      "Body\n",
      "markdown",
    );
    expect(file).not.toContain("reviewers");
    expect(parseDocumentFile(file, "markdown").meta.review).toBeNull();
  });
  it("reads a legacy YAML file as review null", () => {
    const file = yamlFile(meta, "Body\n");
    expect(parseDocumentFile(file, "markdown").meta.review).toBeNull();
  });
  it("rejects a leading zero in reviewEvery", () => {
    const file = composeDocumentFile(
      { ...REVIEW_META, review: REVIEW },
      "Body\n",
      "markdown",
    ).replace("reviewEvery: 12", "reviewEvery: 012");
    expect(() => parseDocumentFile(file, "markdown")).toThrow(FrontmatterError);
  });
  it("rejects reviewers with extra keys or a different key order", () => {
    const good = composeDocumentFile(
      { ...REVIEW_META, review: REVIEW },
      "Body\n",
      "markdown",
    );
    const reordered = good.replace(
      '{"type":"group","id":"00000000-0000-4000-8000-0000000000aa","name":"Ops \\u003e Net"}',
      '{"id":"00000000-0000-4000-8000-0000000000aa","type":"group","name":"Ops \\u003e Net"}',
    );
    expect(reordered).not.toBe(good);
    expect(() => parseDocumentFile(reordered, "markdown")).toThrow(
      FrontmatterError,
    );
  });
  it.each([
    ["interval out of range", { ...REVIEW, everyMonths: 0 }],
    ["interval above max", { ...REVIEW, everyMonths: 121 }],
    [
      "unsorted reviewers",
      { ...REVIEW, reviewers: [...REVIEW.reviewers].reverse() },
    ],
    ["lastReviewed without reviewedBy", { ...REVIEW, reviewedBy: null }],
  ])("rejects %s", (_label, review) => {
    expect(() =>
      composeDocumentFile({ ...REVIEW_META, review }, "x", "markdown"),
    ).toThrow(FrontmatterError);
  });
});

describe("python header", () => {
  const review = {
    reviewers: [
      {
        type: "user" as const,
        id: "0b0e7c1a-5a4e-4a8e-9b1f-2c3d4e5f6a7b",
        name: "Ada Lovelace",
      },
    ],
    everyMonths: 6,
    since: meta.created,
    lastReviewed: "2026-09-01T00:00:00.000Z",
    reviewedBy: { id: null, name: "Reviewer > one" },
  };
  const pyMeta = {
    ...authored,
    title: 'deploy_prod "v2"',
    review,
    appearance: { icon: { type: "builtin" as const, name: "code" as const } },
  };

  it("composes a runnable comment header and parses it back byte-exact", () => {
    const file = composeDocumentFile(
      pyMeta,
      "import sys\n\nprint(1)\n",
      "python",
    );
    expect(file.startsWith("# weaver\n# id: ")).toBe(true);
    expect(file).toContain('\n# title: "deploy_prod \\"v2\\""\n');
    expect(file).toContain(
      '\n# reviewedBy: {"id":null,"name":"Reviewer \\u003e one"}\n',
    );
    expect(file).toContain(
      '\n# appearance: {"icon":{"type":"builtin","name":"code"}}\n# /weaver\n\nimport sys\n',
    );
    expect(
      file
        .split("\n")
        .filter(
          (line) =>
            line.length &&
            !line.startsWith("#") &&
            !line.startsWith("import") &&
            !line.startsWith("print"),
        ),
    ).toEqual([]);
    const parsed = parseDocumentFile(file, "python");
    expect(parsed).toEqual({
      meta: pyMeta,
      body: "import sys\n\nprint(1)\n",
      legacy: false,
    });
    expect(composeDocumentFile(parsed.meta, parsed.body, "python")).toBe(file);
  });

  it("keeps a shebang on line one and returns it with the body", () => {
    const body = "#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\nprint(1)\n";
    const file = composeDocumentFile({ ...meta, title: "t" }, body, "python");
    expect(file.startsWith("#!/usr/bin/env python3\n# weaver\n")).toBe(true);
    const parsed = parseDocumentFile(file, "python");
    expect(parsed.body).toBe(body);
    expect(composeDocumentFile(parsed.meta, parsed.body, "python")).toBe(file);
  });

  it("round-trips an empty body and a shebang-only body", () => {
    for (const body of ["", "#!/usr/bin/python\n"]) {
      const file = composeDocumentFile({ ...meta, title: "t" }, body, "python");
      const parsed = parseDocumentFile(file, "python");
      expect(parsed.body).toBe(body);
      expect(composeDocumentFile(parsed.meta, parsed.body, "python")).toBe(
        file,
      );
    }
  });

  it("adds a trailing newline to a body without one", () => {
    const file = composeDocumentFile(
      { ...meta, title: "t" },
      "x = 1",
      "python",
    );
    expect(file.endsWith("# /weaver\n\nx = 1\n")).toBe(true);
  });

  it("rejects non-canonical and malformed python headers", () => {
    const file = composeDocumentFile(
      { ...meta, title: "t" },
      "pass\n",
      "python",
    );
    expect(() =>
      parseDocumentFile(file.replace('# title: "t"', "# title: 't'"), "python"),
    ).toThrow(FrontmatterError);
    expect(() =>
      parseDocumentFile(file.replace("# /weaver\n", ""), "python"),
    ).toThrow(FrontmatterError);
    expect(() => parseDocumentFile("print(1)\n", "python")).toThrow(
      FrontmatterError,
    );
    expect(() => parseDocumentFile(file, "markdown")).toThrow(FrontmatterError);
  });
});
