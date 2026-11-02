import { describe, expect, it } from "vitest";
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

  it("bounds how many targets one write may resolve", async () => {
    const source = Array.from({ length: 300 }, (_, i) => `[[T${i}]]`).join(" ");
    const result = await run(source);
    expect(result.markdown).toBe(source);
    expect(result.unresolvedLinks.length).toBeLessThanOrEqual(201);
    expect(result.unresolvedLinks.at(-1)?.reason).toBe("too_many_links");
  });
});
