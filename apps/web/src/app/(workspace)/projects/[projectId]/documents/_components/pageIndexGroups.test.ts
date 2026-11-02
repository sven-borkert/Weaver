import { describe, expect, it } from "vitest";
import { groupIndexPages, type IndexPage } from "./pageIndexGroups";

const page = (id: string, type: string | null): IndexPage => ({
  id,
  title: id,
  path: `${id}.md`,
  type,
  summary: null,
});

describe("groupIndexPages", () => {
  it("groups consecutive pages by type ignoring case and labels untyped pages", () => {
    const groups = groupIndexPages([
      page("a", "Entity"),
      page("b", "entity"),
      page("c", "topic"),
      page("d", null),
    ]);
    expect(groups.map((g) => [g.label, g.pages.map((p) => p.id)])).toEqual([
      ["Entity", ["a", "b"]],
      ["topic", ["c"]],
      ["Untyped", ["d"]],
    ]);
  });

  it("returns no groups for no pages", () => {
    expect(groupIndexPages([])).toEqual([]);
  });
});
