import { describe, expect, it } from "vitest";
import { classifyDeletedPath } from "./recovery";

describe("classifyDeletedPath", () => {
  it("classifies document paths at any depth", () => {
    expect(classifyDeletedPath("scripts/deploy.py")).toEqual({
      kind: "document",
      resourcePath: "scripts/deploy.py",
    });
    expect(classifyDeletedPath("guide.md")).toEqual({
      kind: "document",
      resourcePath: "guide.md",
    });
    expect(classifyDeletedPath("docs/guide.md")).toEqual({
      kind: "document",
      resourcePath: "docs/guide.md",
    });
  });

  it("classifies a table by its schema file and names the table directory", () => {
    expect(classifyDeletedPath("tables/team/roster.table/schema.json")).toEqual(
      { kind: "table", resourcePath: "tables/team/roster.table" },
    );
    expect(classifyDeletedPath("tables/roster.table/schema.json")).toEqual({
      kind: "table",
      resourcePath: "tables/roster.table",
    });
  });

  it("ignores a table's data file so one deleted table yields one candidate", () => {
    expect(
      classifyDeletedPath("tables/team/roster.table/data.jsonl"),
    ).toBeNull();
  });

  it("ignores everything that is not a recoverable resource", () => {
    for (const path of [
      "tables/notes.md",
      "docs/guide.assets/a.png",
      "docs/guide.assets/stray.md",
      "project.json",
      ".git/config",
      "tables/team/NotATable/schema.json",
      "schema.json",
      "docs//guide.md",
    ]) {
      expect(classifyDeletedPath(path)).toBeNull();
    }
  });
});
