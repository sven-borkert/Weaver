import { describe, expect, it } from "vitest";

import {
  MAX_SEARCH_ALIASES,
  MAX_SEARCH_ALIAS_CHARACTERS,
  boundSearchAliases,
  boundSearchHeadingPath,
} from "./publicBounds";

describe("public knowledge result bounds", () => {
  it("preserves accepted heading and alias boundaries", () => {
    const headings = Array.from({ length: 6 }, () => "h".repeat(200));
    const aliases = Array.from({ length: MAX_SEARCH_ALIASES }, () =>
      "a".repeat(MAX_SEARCH_ALIAS_CHARACTERS),
    );

    expect(boundSearchHeadingPath(headings)).toEqual(headings);
    expect(boundSearchAliases(aliases)).toEqual(aliases);
  });

  it("truncates heading paths, alias counts, and their components", () => {
    const headings = Array.from({ length: 7 }, () => "h".repeat(201));
    const aliases = Array.from({ length: MAX_SEARCH_ALIASES + 1 }, () =>
      "a".repeat(MAX_SEARCH_ALIAS_CHARACTERS + 1),
    );

    expect(boundSearchHeadingPath(headings)).toHaveLength(6);
    expect(boundSearchHeadingPath(headings)[0]).toHaveLength(200);
    expect(boundSearchAliases(aliases)).toHaveLength(MAX_SEARCH_ALIASES);
    expect(boundSearchAliases(aliases)[0]).toHaveLength(
      MAX_SEARCH_ALIAS_CHARACTERS,
    );
  });
});
