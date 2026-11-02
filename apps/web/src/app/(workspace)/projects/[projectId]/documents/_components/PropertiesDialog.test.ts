import { describe, expect, it } from "vitest";
import { propertiesPatch, splitTags } from "./PropertiesDialog";

const base = { type: "entity", summary: "A person", tags: "a, b" };

describe("splitTags", () => {
  it("trims, drops blanks and duplicates", () => {
    expect(splitTags(" a, b ,, a ,c")).toEqual(["a", "b", "c"]);
    expect(splitTags("")).toEqual([]);
  });
});

describe("propertiesPatch", () => {
  it("sends nothing when nothing changed", () => {
    expect(propertiesPatch({ ...base, type: " entity " }, base)).toEqual({});
  });

  it("sends only the changed fields and clears emptied ones with null", () => {
    expect(
      propertiesPatch({ type: "", summary: "A person", tags: "b, a" }, base),
    ).toEqual({ type: null, tags: ["b", "a"] });
    expect(propertiesPatch({ ...base, tags: " " }, base)).toEqual({
      tags: null,
    });
    expect(propertiesPatch({ ...base, summary: "New" }, base)).toEqual({
      summary: "New",
    });
  });
});
