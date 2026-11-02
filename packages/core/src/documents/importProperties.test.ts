import { describe, expect, it } from "vitest";
import { importedProperties } from "./importProperties";

const header = (properties: unknown) =>
  `<!-- weaver\nid: 11111111-1111-4111-8111-111111111111\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\nproperties: ${JSON.stringify(properties)}\n-->\n\n# T\n\nBody\n`;

describe("importedProperties", () => {
  it("reads YAML scalars, flow and block lists and merges aliases into tags", () => {
    expect(
      importedProperties(
        "---\ntitle: T\ntype: \"entity\"\nsummary: 'It''s short'\ntags: [a, \"b c\"]\naliases:\n  - d\n  - a\n---\n\nBody\n",
      ),
    ).toEqual({
      type: "entity",
      summary: "It's short",
      tags: ["a", "b c", "d", "a"],
    });
  });

  it("drops the source type, over-long fields and bad tags one by one", () => {
    expect(
      importedProperties(
        `---\ntype: Source\nsummary: ${"x".repeat(400)}\ntags: [ok, ${"y".repeat(60)}]\n---\n\nB\n`,
      ),
    ).toEqual({ tags: ["ok"] });
    expect(importedProperties("---\ntype: source\n---\n\nB\n")).toBeUndefined();
  });

  it("takes only type, summary and tags from a Weaver header", () => {
    expect(
      importedProperties(
        header({
          type: "concept",
          summary: "s",
          tags: ["t"],
          reviewExempt: true,
          sources: [{ kind: "url", url: "https://x.test" }],
        }),
      ),
    ).toEqual({ type: "concept", summary: "s", tags: ["t"] });
    expect(importedProperties(header({ reviewExempt: true }))).toBeUndefined();
  });

  it("returns undefined for plain files", () => {
    expect(importedProperties("# T\n\nBody\n")).toBeUndefined();
  });
});
