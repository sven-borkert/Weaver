import { describe, expect, it } from "vitest";
import {
  JsonPathError,
  JsonPathLimitError,
  queryJsonPath,
  type JsonValue,
} from "./jsonPath";

const doc: JsonValue = {
  metadata: { target_account: "prod" },
  security_groups: [
    { GroupId: "sg-aaa", GroupName: "web-sg", FromPort: 443 },
    { GroupId: "sg-bbb", GroupName: "app-sg" },
    { GroupId: "sg-ccc", GroupName: "db-sg", FromPort: 5432 },
  ],
  nested: { deep: { deeper: { marker: "found" } }, marker: "shallow" },
  "key with space": 42,
};

describe("queryJsonPath", () => {
  it("returns the root for $", () => {
    expect(queryJsonPath(doc, "$")).toEqual([doc]);
  });

  it("reads nested children and bracket children", () => {
    expect(queryJsonPath(doc, "$.metadata.target_account")).toEqual(["prod"]);
    expect(queryJsonPath(doc, "$['key with space']")).toEqual([42]);
    expect(queryJsonPath(doc, '$["key with space"]')).toEqual([42]);
  });

  it("returns [] for missing children", () => {
    expect(queryJsonPath(doc, "$.nope.deeper")).toEqual([]);
  });

  it("wildcard expands arrays and objects", () => {
    expect(queryJsonPath(doc, "$.security_groups[*].GroupId")).toEqual([
      "sg-aaa",
      "sg-bbb",
      "sg-ccc",
    ]);
    expect(queryJsonPath(doc, "$.metadata.*")).toEqual(["prod"]);
  });

  it("indexes arrays, supports negatives, and slices", () => {
    expect(queryJsonPath(doc, "$.security_groups[0].GroupId")).toEqual([
      "sg-aaa",
    ]);
    expect(queryJsonPath(doc, "$.security_groups[-1].GroupId")).toEqual([
      "sg-ccc",
    ]);
    expect(queryJsonPath(doc, "$.security_groups[9]")).toEqual([]);
    expect(queryJsonPath(doc, "$.security_groups[1:].length")).toEqual([2]);
    expect(queryJsonPath(doc, "$.security_groups[0:2][*].GroupName")).toEqual([
      "web-sg",
      "app-sg",
    ]);
  });

  it("descendant search finds keys at any depth", () => {
    expect(queryJsonPath(doc, "$..marker")).toEqual(["shallow", "found"]);
  });

  it("filters by equality, numeric comparison, and existence", () => {
    expect(
      queryJsonPath(
        doc,
        "$.security_groups[?(@.GroupName == 'app-sg')].GroupId",
      ),
    ).toEqual(["sg-bbb"]);
    expect(
      queryJsonPath(doc, "$.security_groups[?(@.FromPort >= 1000)].GroupId"),
    ).toEqual(["sg-ccc"]);
    expect(
      queryJsonPath(doc, "$.security_groups[?(@.FromPort)].GroupId"),
    ).toEqual(["sg-aaa", "sg-ccc"]);
    expect(
      queryJsonPath(
        doc,
        "$.security_groups[?(@.GroupName != 'app-sg')].GroupId",
      ),
    ).toEqual(["sg-aaa", "sg-ccc"]);
  });

  it("supports && and does not split quoted literals containing &&", () => {
    const d = {
      items: [
        { a: 1, b: "x && y" },
        { a: 1, b: "z" },
        { a: 2, b: "x && y" },
      ],
    };
    expect(queryJsonPath(d, "$.items[?(@.a == 1 && @.b == 'z')]")).toEqual([
      { a: 1, b: "z" },
    ]);
    expect(queryJsonPath(d, "$.items[?(@.b == 'x && y')].length")).toEqual([]);
    expect(queryJsonPath(d, "$.items[?(@.b == 'x && y')]")).toHaveLength(2);
  });

  it("treats non-array filter targets as no match", () => {
    expect(queryJsonPath(doc, "$.metadata[?(@.x == 1)]")).toEqual([]);
  });

  it("throws JsonPathError for malformed paths", () => {
    expect(() => queryJsonPath(doc, "security_groups")).toThrow(JsonPathError);
    expect(() => queryJsonPath(doc, "$.security_groups[")).toThrow(
      JsonPathError,
    );
    expect(() => queryJsonPath(doc, "$.a[?(@.x === 1)]")).toThrow(
      JsonPathError,
    );
    expect(() => queryJsonPath(doc, "$.a[1:2:3]")).toThrow(JsonPathError);
  });

  it("filters with contains (case-insensitive substring)", () => {
    expect(
      queryJsonPath(doc, "$.security_groups[?(@.GroupName contains 'SG')]"),
    ).toHaveLength(3);
    expect(
      queryJsonPath(doc, "$.security_groups[?(@.GroupName contains 'web')]"),
    ).toEqual([{ GroupId: "sg-aaa", GroupName: "web-sg", FromPort: 443 }]);
    expect(
      queryJsonPath(doc, "$.security_groups[?(@.GroupName contains 'nope')]"),
    ).toEqual([]);
  });

  it("contains never matches non-string values or non-string literals", () => {
    expect(
      queryJsonPath(doc, "$.security_groups[?(@.FromPort contains '44')]"),
    ).toEqual([]);
    expect(
      queryJsonPath(doc, "$.security_groups[?(@.GroupName contains 443)]"),
    ).toEqual([]);
  });

  it("contains composes with && and requires surrounding whitespace", () => {
    expect(
      queryJsonPath(
        doc,
        "$.security_groups[?(@.GroupName contains 'sg' && @.FromPort >= 1000)]",
      ),
    ).toEqual([{ GroupId: "sg-ccc", GroupName: "db-sg", FromPort: 5432 }]);
    expect(() =>
      queryJsonPath(doc, "$.security_groups[?(@.GroupNamecontains 'web')]"),
    ).toThrow(JsonPathError);
  });
});

describe("queryJsonPath hardening regressions", () => {
  it("does not match prototype-chain keys", () => {
    expect(queryJsonPath({}, "$.constructor")).toEqual([]);
    expect(queryJsonPath({ a: {} }, "$..toString")).toEqual([]);
    expect(
      queryJsonPath({ items: [{ x: 1 }] }, "$.items[?(@.toString)]"),
    ).toEqual([]);
  });

  it("parses the @['key'] form inside filters", () => {
    const d = { items: [{ "k k": 5 }, { "k k": 6 }] };
    expect(queryJsonPath(d, "$.items[?(@['k k'] == 5)]")).toEqual([
      { "k k": 5 },
    ]);
  });

  it("expands large arrays without RangeError", () => {
    const d = { big: Array.from({ length: 150000 }, (_, i) => i) };
    const result = queryJsonPath(d, "$.big[*]");
    expect(result).toHaveLength(150000);
    expect(result[149999]).toBe(149999);
  });

  it("rejects the descendant wildcard $..*", () => {
    expect(() => queryJsonPath(doc, "$..*")).toThrow(JsonPathError);
  });

  it("matches escaped quotes in string literals", () => {
    const d = { items: [{ b: "it's" }, { b: "other" }] };
    expect(queryJsonPath(d, "$.items[?(@.b == 'it\\'s')]")).toEqual([
      { b: "it's" },
    ]);
  });

  it("JsonPathError exposes a numeric position", () => {
    try {
      queryJsonPath(doc, "no-dollar");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(JsonPathError);
      expect(typeof (e as JsonPathError).position).toBe("number");
    }
  });
});

// Deliberate deviation from the ported source: without these guards a
// pathological path can build an unbounded intermediate match array, or
// recurse without limit, before json.ts's page/byte-budget clip ever runs.
describe("queryJsonPath resource guards", () => {
  it("throws JsonPathLimitError when a wildcard expansion exceeds the match cap", () => {
    const d: JsonValue = {
      big: Array.from({ length: 200_001 }, (_, i) => i),
    };
    expect(() => queryJsonPath(d, "$.big[*]")).toThrow(JsonPathLimitError);
  });

  it("allows an ordinary broad query exactly at the match cap", () => {
    const d: JsonValue = {
      big: Array.from({ length: 200_000 }, (_, i) => i),
    };
    const result = queryJsonPath(d, "$.big[*]");
    expect(result).toHaveLength(200_000);
    expect(result[199_999]).toBe(199_999);
  });

  it("throws JsonPathLimitError when descendant recursion exceeds the depth cap", () => {
    let deep: JsonValue = { marker: "found" };
    for (let i = 0; i < 520; i++) deep = { child: deep };
    expect(() => queryJsonPath(deep, "$..marker")).toThrow(JsonPathLimitError);
  });
});
