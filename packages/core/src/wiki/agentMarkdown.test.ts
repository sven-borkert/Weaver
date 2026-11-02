import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { parseDocumentBody } from "../editor/markdown";
import {
  preprocessAgentMarkdown,
  type AgentLinkResolver,
} from "./agentMarkdown";

const DOC = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TABLE = "33333333-3333-4333-8333-333333333333";

const resolver: AgentLinkResolver = {
  async byTitle(title) {
    if (title === "Alpha") return [{ id: DOC, title: "Alpha" }];
    if (title === "Twin")
      return [
        { id: DOC, title: "Twin" },
        { id: OTHER, title: "Twin" },
      ];
    return [];
  },
  async byPath(path) {
    return path === "wiki/topics/alpha.md" ? { id: DOC, title: "Alpha" } : null;
  },
  async exists(kind, id) {
    if (kind === "document" && id === DOC) return { title: "Alpha" };
    if (kind === "table" && id === TABLE) return { title: "Numbers" };
    return null;
  },
};

function weaverTargets(markdown: string): string[] {
  const found: string[] = [];
  const walk = (node: JSONContent) => {
    if (node.type === "crossref")
      found.push(`weaver://${node.attrs?.targetType}/${node.attrs?.targetId}`);
    if (node.type === "image" && /weaver:/i.test(String(node.attrs?.src)))
      found.push(String(node.attrs?.src));
    for (const mark of node.marks ?? [])
      if (mark.type === "link" && /^\s*weaver:/i.test(String(mark.attrs?.href)))
        found.push(String(mark.attrs?.href));
    node.content?.forEach(walk);
  };
  walk(parseDocumentBody(markdown));
  return found;
}

const run = (markdown: string, folderPath: string[] = ["wiki", "topics"]) =>
  preprocessAgentMarkdown(markdown, resolver, { folderPath });

describe("preprocessAgentMarkdown", () => {
  it("resolves a wikilink with exactly one match to the tracked form", async () => {
    const result = await run("See [[Alpha]] now.");
    expect(result.markdown).toBe(`See [Alpha](weaver://document/${DOC}) now.`);
    expect(result.unresolvedLinks).toEqual([]);
    expect(result.invalidLinks).toEqual([]);
  });

  it("leaves an ambiguous or unknown wikilink as text and reports it", async () => {
    const result = await run("[[Twin]] and [[Nope]]");
    expect(result.markdown).toBe("[[Twin]] and [[Nope]]");
    expect(result.unresolvedLinks).toEqual([
      { target: "Twin", reason: "ambiguous" },
      { target: "Nope", reason: "not_found" },
    ]);
  });

  it("resolves a relative .md path against the page's folder by exact path", async () => {
    const result = await run("[A](alpha.md) [B](../topics/alpha.md)");
    expect(result.markdown).toBe(
      `[Alpha](weaver://document/${DOC}) [Alpha](weaver://document/${DOC})`,
    );
  });

  it("keeps the label of an unresolved .md path as plain text", async () => {
    const result = await run(
      "[Label](missing.md) and [Up](../../../escape.md)",
    );
    expect(result.markdown).toBe("Label and Up");
    expect(result.unresolvedLinks).toEqual([
      { target: "missing.md", reason: "not_found" },
      { target: "../../../escape.md", reason: "not_found" },
    ]);
  });

  it("keeps a valid tracked link and rejects one with an unknown target", async () => {
    const result = await run(
      `[a](weaver://document/${DOC}) [t](weaver://table/${TABLE}) [gone](weaver://document/${OTHER})`,
    );
    expect(result.markdown).toBe(
      `[a](weaver://document/${DOC}) [t](weaver://table/${TABLE}) gone`,
    );
    expect(result.invalidLinks).toEqual([
      { target: `weaver://document/${OTHER}`, reason: "unknown_target" },
    ]);
  });

  it("reports near-miss link forms as invalid", async () => {
    const result = await run(
      `[a](weaver://doc/${DOC}) [b](weaver:/document/${DOC}) [c](weaver://document/not-a-uuid) [d](WEAVER://document/${DOC})`,
    );
    expect(result.markdown).toBe("a b c d");
    expect(result.invalidLinks.map((link) => link.reason)).toEqual([
      "near_miss",
      "near_miss",
      "near_miss",
      "near_miss",
    ]);
  });

  it("does not touch code spans, fenced blocks, external links or images", async () => {
    const source = [
      "`[[Alpha]]` and [site](https://example.com/a.md)",
      "```",
      "[[Alpha]] [x](alpha.md)",
      "```",
      "![pic](alpha.md)",
    ].join("\n");
    const result = await run(source);
    expect(result.markdown).toBe(source);
    expect(result.unresolvedLinks).toEqual([]);
  });

  it("looks a repeated target up once", async () => {
    let calls = 0;
    await preprocessAgentMarkdown(
      "[[Alpha]] [[Alpha]] [[Alpha]]",
      {
        ...resolver,
        byTitle: async (title) => {
          calls += 1;
          return resolver.byTitle(title);
        },
      },
      { folderPath: [] },
    );
    expect(calls).toBe(1);
  });

  it("resolves a tracked label containing brackets safely", async () => {
    const result = await preprocessAgentMarkdown(
      "[[Odd]]",
      {
        ...resolver,
        byTitle: async () => [{ id: DOC, title: "Odd [x]" }],
      },
      { folderPath: [] },
    );
    expect(result.markdown).toBe(`[Odd \\[x\\]](weaver://document/${DOC})`);
  });

  it("reports every wikilink the lookup budget refuses and leaves it as text", async () => {
    const source = Array.from({ length: 300 }, (_, i) => `[[T${i}]]`).join(" ");
    const result = await run(source);
    expect(result.markdown).toBe(source);
    const refused = result.unresolvedLinks.filter(
      (link) => link.reason === "too_many_links",
    );
    expect(refused).toHaveLength(100);
    expect(refused[0]?.target).toBe("T200");
    expect(refused.at(-1)?.target).toBe("T299");
  });

  it("falls back to plain text for tracked and .md forms past the budget", async () => {
    const filler = Array.from({ length: 200 }, (_, i) => `[[T${i}]]`).join(" ");
    const result = await run(
      `${filler} [tracked](weaver://document/${DOC}) [path](alpha.md)`,
    );
    expect(result.markdown).toBe(`${filler} tracked path`);
    expect(
      result.unresolvedLinks
        .filter((link) => link.reason === "too_many_links")
        .map((link) => link.target),
    ).toEqual([`weaver://document/${DOC}`, "alpha.md"]);
    expect(weaverTargets(result.markdown)).toEqual([]);
  });

  describe("what the writer's parser sees", () => {
    it.each([
      ["angle-bracket destination", `[a](<weaver://document/${OTHER}>)`, "a"],
      ["titled destination", `[a](weaver://document/${OTHER} "t")`, "a"],
      ["angle-bracket near miss", `[a](<weaver://doc/${OTHER}>)`, "a"],
      [
        "reference definition",
        `[a]: weaver://document/${OTHER}\n\nsee [a]`,
        "see a",
      ],
      [
        "autolink",
        `<weaver://document/${OTHER}>`,
        `weaver://document/${OTHER}`,
      ],
      ["image", `![pic](weaver://document/${OTHER})`, "pic"],
    ])("demotes an unverified %s", async (_name, source, text) => {
      const result = await run(source);
      expect(weaverTargets(result.markdown)).toEqual([]);
      expect(result.markdown.trim()).toBe(text);
      expect(result.invalidLinks).toHaveLength(1);
      expect(result.invalidLinks[0]?.reason).toBe("unverified");
    });

    it("demotes a known target reached only through a form this pass never checked", async () => {
      const result = await run(`[a](<weaver://document/${DOC}>)`);
      expect(result.markdown).toBe("a");
      expect(result.invalidLinks).toEqual([
        { target: `weaver://document/${DOC}`, reason: "unverified" },
      ]);
    });

    it("demotes a crossref inside a code span the parser splits across blocks", async () => {
      const result = await run(`\`x\n\n[a](weaver://document/${OTHER}) \``);
      expect(weaverTargets(result.markdown)).toEqual([]);
      expect(result.invalidLinks).toEqual([
        { target: `weaver://document/${OTHER}`, reason: "unverified" },
      ]);
    });

    it("demotes a link re-formed by stripping an inner one", async () => {
      const result = await run(`[[x](missing.md)](weaver://document/${OTHER})`);
      expect(result.markdown).toBe("x");
      expect(result.unresolvedLinks).toEqual([
        { target: "missing.md", reason: "not_found" },
      ]);
      expect(result.invalidLinks).toEqual([
        { target: `weaver://document/${OTHER}`, reason: "unverified" },
      ]);
    });

    it("keeps a verified inner link; the parser reads the outer form as text", async () => {
      const result = await run(`[[x](alpha.md)](weaver://document/${OTHER})`);
      expect(weaverTargets(result.markdown)).toEqual([
        `weaver://document/${DOC}`,
      ]);
      expect(result.invalidLinks).toEqual([]);
    });

    it("leaves Markdown without offenders byte-identical", async () => {
      const source = `  Intro [a](weaver://document/${DOC})\n\n\n* odd   spacing\n`;
      const result = await run(source);
      expect(result.markdown).toBe(source);
      expect(result.invalidLinks).toEqual([]);
    });

    it("does not treat fenced code as a link", async () => {
      const source = `\`\`\`\n[a](weaver://document/${OTHER})\n\`\`\`\n`;
      const result = await run(source);
      expect(result.markdown).toBe(source);
      expect(result.invalidLinks).toEqual([]);
    });

    it("converges on a label that spells a link", async () => {
      const result = await run(
        `[\\[b\\](weaver://document/${OTHER})](<weaver://document/${OTHER}>)`,
      );
      expect(weaverTargets(result.markdown)).toEqual([]);
      expect(result.invalidLinks.length).toBeGreaterThan(0);
    });

    it("settles nested destinations within the round cap", async () => {
      const nested = Array.from({ length: 8 }).reduce<string>(
        (inner) => `[${inner}](<weaver://document/${OTHER}>)`,
        "x",
      );
      const result = await run(nested);
      expect(weaverTargets(result.markdown)).toEqual([]);
    });

    it("refuses the write when the links do not settle within the cap", async () => {
      await expect(
        preprocessAgentMarkdown(`[a](<weaver://document/${OTHER}>)`, resolver, {
          folderPath: [],
          maxDemotionRounds: 1,
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        details: { reason: "UNVERIFIABLE_LINKS" },
      });
    });
  });
});
