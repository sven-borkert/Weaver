import MarkdownIt from "markdown-it";
import { describe, expect, it, vi } from "vitest";
import { ArtifactReadError } from "./errors";
import {
  readText,
  readTextOverview,
  searchText,
  textPositionAfterPrefix,
  type TextPosition,
  type TextReadInput,
} from "./text";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("text artifact readers", () => {
  it("reads_bom_crlf_and_lone_cr_with_exact_locations", () => {
    const data = bytes("\uFEFFa😀\r\nb\rc\n");
    expect(readTextOverview(data, {})).toEqual({
      lineCount: 3,
      headingCount: 0,
      headings: [],
      nextOffset: null,
    });
    expect(readText(data, { limit: 1 })).toEqual({
      text: "a😀\r\n",
      start: { line: 1, charOffset: 0 },
      end: { line: 2, charOffset: 0 },
      lineCount: 1,
      nextPosition: { line: 2, charOffset: 0 },
    });
    expect(
      readText(data, { position: { line: 1, charOffset: 4 }, limit: 1 }).text,
    ).toBe("\n");
    expect(readText(data, { startLine: 2, endLine: 2 }).text).toBe("b\r");
    expect(readText(data, { position: { line: 4, charOffset: 0 } })).toEqual({
      text: "",
      start: { line: 4, charOffset: 0 },
      end: { line: 4, charOffset: 0 },
      lineCount: 0,
      nextPosition: null,
    });
    expect(
      textPositionAfterPrefix({ line: 1, charOffset: 0 }, "a😀\r\nb\rc\n", 4),
    ).toEqual({ line: 1, charOffset: 4 });
    expect(
      textPositionAfterPrefix({ line: 1, charOffset: 0 }, "a😀\r\nb\rc\n", 7),
    ).toEqual({ line: 3, charOffset: 0 });
  });

  it("continues_long_unicode_line_without_gaps", () => {
    const selected = "a".repeat(131069) + "😀".repeat(70000) + "\r\ntail\r";
    const data = bytes("skip\n" + selected + "excluded");
    let position: TextPosition | undefined;
    let actual = "";
    let pages = 0;
    do {
      const page = readText(data, { startLine: 2, endLine: 3, position });
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(128 * 1024);
      expect(page.text).not.toMatch(/[\uD800-\uDBFF]$/u);
      expect(page.text).not.toMatch(/^[\uDC00-\uDFFF]/u);
      expect(page.text.length).toBeGreaterThan(0);
      if (position) expect(page.start).toEqual(position);
      actual += page.text;
      position = page.nextPosition ?? undefined;
      pages++;
      expect(pages).toBeLessThan(10);
    } while (position);
    expect(actual).toBe(selected);
    expect(pages).toBeGreaterThan(1);
  });

  it("preserves_terminators_at_the_byte_ceiling", () => {
    const data = bytes("a".repeat(131071) + "\r\nb");
    const first = readText(data, {});
    expect(first.text).toBe("a".repeat(131071));
    expect(first.nextPosition).toEqual({ line: 1, charOffset: 131071 });
    const second = readText(data, { position: first.nextPosition! });
    expect(first.text + second.text).toBe("a".repeat(131071) + "\r\nb");
    expect(second.end).toEqual({ line: 2, charOffset: 1 });
    expect(second.nextPosition).toBeNull();
  });

  it("outline_ignores_fenced_headings_and_supports_setext", () => {
    const data = bytes(
      "Intro\n# Parent #\nbody\n```md\n# hidden\n```\nChild\n-----\ntext\n~~~\nHidden\n======\n~~~\n# Next\n",
    );
    expect(readTextOverview(data, { markdown: true })).toEqual({
      lineCount: 14,
      headingCount: 3,
      nextOffset: null,
      headings: [
        {
          id: "heading-2",
          title: "Parent",
          level: 1,
          startLine: 2,
          endLine: 13,
        },
        {
          id: "heading-7",
          title: "Child",
          level: 2,
          startLine: 7,
          endLine: 13,
        },
        {
          id: "heading-14",
          title: "Next",
          level: 1,
          startLine: 14,
          endLine: 14,
        },
      ],
    });
    expect(
      readText(data, { markdown: true, sectionId: "heading-7" }).text,
    ).toBe("Child\n-----\ntext\n~~~\nHidden\n======\n~~~\n");
    const first = readTextOverview(data, { markdown: true, limit: 1 });
    expect(first.headingCount).toBe(3);
    expect(first.nextOffset).toBe(1);
    expect(
      readTextOverview(data, {
        markdown: true,
        offset: 1,
        limit: 2,
      }).headings.map((h) => h.id),
    ).toEqual(["heading-7", "heading-14"]);
  });

  it.each([
    "___",
    "_ _ _",
    "_\t_\t_",
    "- - -",
    "-- --",
    "-\t-\t-",
    "***",
    "* * *",
    "*\t*\t*",
  ])("starts_setext_sections_after_thematic_break_%j", (marker) => {
    const data = bytes(`before\n${marker}\nTitle\n-----\n`);
    expect(readTextOverview(data, { markdown: true }).headings).toEqual([
      { id: "heading-3", title: "Title", level: 2, startLine: 3, endLine: 4 },
    ]);
    expect(readText(data, { markdown: true, sectionId: "heading-3" })).toEqual({
      text: "Title\n-----\n",
      start: { line: 3, charOffset: 0 },
      end: { line: 5, charOffset: 0 },
      lineCount: 2,
      nextPosition: null,
    });
  });

  it("keeps_setext_precedence_and_thematic_markers_inside_fences", () => {
    const setext = bytes("before\n---\nTitle\n-----\n");
    expect(readTextOverview(setext, { markdown: true }).headings).toEqual([
      { id: "heading-1", title: "before", level: 2, startLine: 1, endLine: 2 },
      { id: "heading-3", title: "Title", level: 2, startLine: 3, endLine: 4 },
    ]);
    const fenced = bytes("before\n```\n___\n- - -\n```\nTitle\n-----\n");
    expect(readTextOverview(fenced, { markdown: true }).headings).toEqual([
      { id: "heading-6", title: "Title", level: 2, startLine: 6, endLine: 7 },
    ]);
    expect(
      readText(fenced, { markdown: true, sectionId: "heading-6" }).text,
    ).toBe("Title\n-----\n");
  });

  it.each(["__", "_-_", "_ _", "***x"])(
    "keeps_non_thematic_marker_%j_in_the_setext_paragraph",
    (marker) => {
      expect(
        readTextOverview(bytes(`before\n${marker}\nTitle\n-----\n`), {
          markdown: true,
        }).headings,
      ).toEqual([
        {
          id: "heading-1",
          title: `before ${marker} Title`,
          level: 2,
          startLine: 1,
          endLine: 4,
        },
      ]);
    },
  );

  it.each(["```", "~~~"])(
    "ignores %s fences inside lists and blockquotes before real headings",
    (fence) => {
      const data = bytes(
        `- ${fence}md\n  # fake list\n  ${fence}\n\n> ${fence}\n> # fake quote\n> ${fence}\n\n# Real\nbody\n`,
      );
      expect(readTextOverview(data, { markdown: true }).headings).toEqual([
        { id: "heading-9", title: "Real", level: 1, startLine: 9, endLine: 10 },
      ]);
      expect(
        readText(data, { markdown: true, sectionId: "heading-9" }).text,
      ).toBe("# Real\nbody\n");
    },
  );

  it.each(["\n", "\r\n", "\r"])(
    "maps repeated container headings and setext sections to original %j bytes",
    (eol) => {
      const source = [
        "# Same",
        "root",
        "- ## Same",
        "  list body",
        "  ### Child",
        "  child body",
        "> ## Same",
        "> quote body",
        "",
        "> Same",
        "> *raw* title",
        "> ---",
        "> setext body",
        "",
        "# Same",
        "last",
        "",
      ];
      const data = bytes(source.join(eol));
      expect(readTextOverview(data, { markdown: true }).headings).toEqual([
        { id: "heading-1", title: "Same", level: 1, startLine: 1, endLine: 14 },
        { id: "heading-3", title: "Same", level: 2, startLine: 3, endLine: 6 },
        { id: "heading-5", title: "Child", level: 3, startLine: 5, endLine: 6 },
        { id: "heading-7", title: "Same", level: 2, startLine: 7, endLine: 9 },
        {
          id: "heading-10",
          title: "Same *raw* title",
          level: 2,
          startLine: 10,
          endLine: 14,
        },
        {
          id: "heading-15",
          title: "Same",
          level: 1,
          startLine: 15,
          endLine: 16,
        },
      ]);
      for (const [start, end] of [
        [1, 14],
        [3, 6],
        [5, 6],
        [7, 9],
        [10, 14],
        [15, 16],
      ] as const) {
        const result = readText(data, {
          markdown: true,
          sectionId: `heading-${start}`,
        });
        expect(result.text).toBe(source.slice(start - 1, end).join(eol) + eol);
        expect(result.start).toEqual({ line: start, charOffset: 0 });
        expect(result.end).toEqual({ line: end + 1, charOffset: 0 });
      }
    },
  );

  it.each([
    "<!--\n# fake\n-->",
    "<script>\n# fake\n</script>",
    "<pre>\n# fake\n</pre>",
    "<div>\n# fake\n</div>",
    "<?processing\n# fake\n?>",
    "<![CDATA[\n# fake\n]]>",
  ])("excludes headings inside HTML block %j", (block) => {
    const data = bytes(`${block}\n\n# Real\nbody\n`);
    expect(readTextOverview(data, { markdown: true }).headings).toEqual([
      { id: "heading-5", title: "Real", level: 1, startLine: 5, endLine: 6 },
    ]);
    expect(
      readText(data, { markdown: true, sectionId: "heading-5" }).text,
    ).toBe("# Real\nbody\n");
  });

  it.each(["<!-- comment -->", "<script></script>", "<?processing ?>"])(
    "starts a setext section after the HTML boundary %j",
    (block) => {
      const data = bytes(`paragraph\n${block}\nTitle\n---\n`);
      expect(readTextOverview(data, { markdown: true }).headings).toEqual([
        { id: "heading-3", title: "Title", level: 2, startLine: 3, endLine: 4 },
      ]);
      expect(
        readText(data, { markdown: true, sectionId: "heading-3" }).text,
      ).toBe("Title\n---\n");
    },
  );

  it.each([
    ["# ###", ""],
    ["#\t###\t", ""],
    ["#   ###   ", ""],
    ["###", ""],
    ["# literal#", "literal#"],
    ["# literal ###", "literal"],
    ["# ### literal", "### literal"],
    ["# literal \\#", "literal \\#"],
    ["# *raw* [link](url) `code`", "*raw* [link](url) `code`"],
  ])("preserves raw heading title for %j", (source, title) => {
    expect(
      readTextOverview(bytes(source + "\n"), { markdown: true }).headings,
    ).toEqual([
      {
        id: "heading-1",
        title,
        level: source === "###" ? 3 : 1,
        startLine: 1,
        endLine: 1,
      },
    ]);
  });

  it.each(["> ", "- "])(
    "does not silently omit deep %j container headings",
    (prefix) => {
      const source = prefix.repeat(128) + "# Deep\n\n# Root\n";
      const data = bytes(source);
      expect(readTextOverview(data, { markdown: true }).headings).toEqual([
        { id: "heading-1", title: "Deep", level: 1, startLine: 1, endLine: 2 },
        { id: "heading-3", title: "Root", level: 1, startLine: 3, endLine: 3 },
      ]);
      expect(
        readText(data, { markdown: true, sectionId: "heading-1" }).text,
      ).toBe(prefix.repeat(128) + "# Deep\n\n");
    },
  );

  it.each([
    new RangeError("private source stack overflow"),
    new Error("private source parser failure"),
  ])(
    "rejects parser failures without partial outlines or file text: %s",
    (failure) => {
      const parse = vi
        .spyOn(MarkdownIt.prototype, "parse")
        .mockImplementation(() => {
          throw failure;
        });
      try {
        const data = bytes("# private source\nbody\n");
        for (const read of [
          () => readTextOverview(data, { markdown: true }),
          () => readText(data, { markdown: true, sectionId: "heading-1" }),
        ]) {
          expect(read).toThrowError(
            expect.objectContaining({
              name: "ArtifactReadError",
              code: "resource_limit",
              message:
                "Markdown outline is too large or complex; read the source by line range",
            }),
          );
        }
        expect(
          readText(data, { markdown: true, startLine: 1, endLine: 1 }).text,
        ).toBe("# private source\n");
        expect(readTextOverview(data, {}).headingCount).toBe(0);
        expect(searchText(data, { query: "body" }).matches[0]).toMatchObject({
          line: 2,
          charOffset: 0,
        });
        expect(parse).toHaveBeenCalledTimes(2);
      } finally {
        parse.mockRestore();
      }
    },
  );

  it("bounds_titles_and_paginates_a_large_outline_without_losing_entries", () => {
    const data = bytes(
      Array.from(
        { length: 600 },
        (_, i) => `# ${i} ${"😀".repeat(1000)}\n`,
      ).join(""),
    );
    let offset: number | undefined;
    const ids: string[] = [];
    do {
      const page = readTextOverview(data, {
        markdown: true,
        offset,
        limit: 500,
      });
      expect(page.headingCount).toBe(600);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        128 * 1024,
      );
      for (const heading of page.headings) {
        expect(Buffer.byteLength(heading.title)).toBeLessThanOrEqual(500);
        expect(heading.title).not.toMatch(/[\uD800-\uDBFF]$/u);
        ids.push(heading.id);
      }
      offset = page.nextOffset ?? undefined;
    } while (offset !== undefined);
    expect(ids).toEqual(
      Array.from({ length: 600 }, (_, i) => `heading-${i + 1}`),
    );
  });

  it("finds_match_after_first_read_window", () => {
    const data = bytes(
      "😀" + "x".repeat(150000) + "NEEDLE\r\nneedle [.*] needle",
    );
    expect(readText(data, {}).text).not.toContain("NEEDLE");
    const first = searchText(data, { query: "needle", limit: 1 });
    expect(first.matches[0]).toMatchObject({ line: 1, charOffset: 150002 });
    expect(Buffer.byteLength(first.matches[0]!.snippet)).toBeLessThanOrEqual(
      500,
    );
    expect(first.nextPosition).toEqual({ line: 1, charOffset: 150008 });
    const second = searchText(data, {
      query: "needle",
      position: first.nextPosition!,
      limit: 2,
    });
    expect(
      second.matches.map(({ line, charOffset }) => ({ line, charOffset })),
    ).toEqual([
      { line: 2, charOffset: 0 },
      { line: 2, charOffset: 12 },
    ]);
    expect(second.nextPosition).toBeNull();
    expect(searchText(data, { query: "[.*]" }).matches).toMatchObject([
      { line: 2, charOffset: 7 },
    ]);
  });

  it("keeps_unicode_case_insensitive_match_offsets_in_original_utf16_units", () => {
    const data = bytes("İ😀NEEDLE needle");
    const result = searchText(data, { query: "needle" });
    expect(result.matches.map((match) => match.charOffset)).toEqual([3, 10]);
  });

  it("returns_surrogate_safe_search_snippets_at_both_edges", () => {
    const result = searchText(bytes("xa" + "😀".repeat(100)), { query: "x" });
    expect(result.matches[0]!.snippet).not.toMatch(/[\uD800-\uDBFF]$/u);
    const later = searchText(bytes("😀".repeat(100) + "ax"), { query: "x" });
    expect(later.matches[0]!.snippet).not.toMatch(/^[\uDC00-\uDFFF]/u);
  });

  it("rejects_invalid_utf8_without_quoting_source", () => {
    const data = Uint8Array.from([...bytes("secret-value"), 0xc0, 0xaf]);
    for (const call of [
      () => readText(data, {}),
      () => readTextOverview(data, {}),
      () => searchText(data, { query: "secret" }),
    ]) {
      expect(call).toThrow(ArtifactReadError);
      expect(call).toThrow("artifact is not valid UTF-8");
      try {
        call();
      } catch (error) {
        expect(String(error)).not.toContain("secret-value");
      }
    }
  });

  it("pins_default_and_maximum_line_search_and_outline_limits", () => {
    const data = bytes(Array.from({ length: 600 }, () => "# match\n").join(""));
    expect(readText(data, {}).lineCount).toBe(100);
    expect(readText(data, { limit: 500 }).lineCount).toBe(500);
    expect(searchText(data, { query: "match" }).matches).toHaveLength(25);
    expect(
      searchText(data, { query: "match", limit: 100 }).matches,
    ).toHaveLength(100);
    expect(readTextOverview(data, { markdown: true }).headings).toHaveLength(
      100,
    );
    expect(
      readTextOverview(data, { markdown: true, limit: 500 }).headings,
    ).toHaveLength(500);
    for (const limit of [0, -1, 501, 1.1, NaN]) {
      expect(() => readText(data, { limit })).toThrow(ArtifactReadError);
      expect(() => readTextOverview(data, { limit })).toThrow(
        ArtifactReadError,
      );
    }
    for (const limit of [0, 101, 1.1, NaN])
      expect(() => searchText(data, { query: "match", limit })).toThrow(
        ArtifactReadError,
      );
  });

  it("rejects_invalid_line_section_position_and_outline_arguments", () => {
    const data = bytes("# Hi\na😀\n");
    const invalid: TextReadInput[] = [
      { startLine: 0 },
      { startLine: 1.5 },
      { startLine: 4 },
      { endLine: 3 },
      { startLine: 2, endLine: 1 },
      { sectionId: "heading-1" },
      { markdown: true, sectionId: "missing" },
      { markdown: true, sectionId: "heading-1", startLine: 1 },
      { position: { line: 0, charOffset: 0 } },
      { position: { line: 2, charOffset: 2 } },
      { position: { line: 1, charOffset: 6 } },
      { position: { line: 3, charOffset: 1 } },
      { startLine: 2, position: { line: 1, charOffset: 0 } },
    ];
    for (const input of invalid)
      expect(() => readText(data, input)).toThrow(ArtifactReadError);
    for (const offset of [-1, 0.1, NaN])
      expect(() => readTextOverview(data, { offset })).toThrow(
        ArtifactReadError,
      );
    expect(() => searchText(data, { query: "" })).toThrow(ArtifactReadError);
    expect(() =>
      textPositionAfterPrefix({ line: 1, charOffset: 0 }, "😀", 1),
    ).toThrow(ArtifactReadError);
  });

  it("keeps_empty_and_unterminated_eof_terminal", () => {
    expect(readTextOverview(bytes(""), {}).lineCount).toBe(0);
    expect(readText(bytes(""), {}).nextPosition).toBeNull();
    const page = readText(bytes("a😀"), {});
    expect(page.end).toEqual({ line: 1, charOffset: 3 });
    expect(readText(bytes("a😀"), { position: page.end }).text).toBe("");
    expect(readTextOverview(bytes("a\n"), {}).lineCount).toBe(1);
    expect(
      searchText(bytes("match"), { query: "match", limit: 1 }).nextPosition,
    ).toBeNull();
  });
});
