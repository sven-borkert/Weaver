import { describe, expect, it } from "vitest";
import { ArtifactReadError } from "./errors";
import { parseYamlValue, queryYaml, readYamlOverview } from "./yaml";

const bytes = (source: string) => new TextEncoder().encode(source);
const parse = (source: string) => parseYamlValue(bytes(source));
function rejects(source: string, code = "malformed") {
  expect(() => parse(source)).toThrow(ArtifactReadError);
  try {
    parse(source);
  } catch (error) {
    expect((error as ArtifactReadError).code).toBe(code);
    expect((error as Error).message).not.toContain("SECRET");
  }
}

describe("YAML normalization", () => {
  it("yaml_normalizes_core_scalars_and_keeps_dates_strings", () => {
    expect(
      parse(
        "date: 2026-10-08\ncount: 3\nflag: true\nnil: null\nno: no\nhex: 0x10\nratio: 1.5\nitems: [a, false]\n",
      ),
    ).toEqual({
      date: "2026-10-08",
      count: 3,
      flag: true,
      nil: null,
      no: "no",
      hex: 16,
      ratio: 1.5,
      items: ["a", false],
    });
    expect(parse("\uFEFF%YAML 1.2\n---\n!!str 2026-10-08")).toBe("2026-10-08");
    expect(parse("")).toBeNull();
    expect(parse("[null, ~, true]")).toEqual([null, null, true]);
    expect(parse("a: &base {x: 1}\nb: {<<: *base}")).toEqual({
      a: { x: 1 },
      b: { "<<": { x: 1 } },
    });
  });

  it("yaml_rejects_duplicates_tags_multi_documents_and_nonstring_keys", () => {
    for (const source of [
      "x: 1\nx: 2",
      'x: 1\n"x": 2',
      "x: !SECRET value",
      "x: !!timestamp 2026-10-08",
      "x: !!binary U0VDUkVU",
      "x: !!set {a: null}",
      "---\nx: 1\n---\nx: 2",
      "1: value",
      "true: value",
      "null: value",
      "? [a, b]\n: value",
      "%YAML 1.1\n---\nx: yes",
      "%YAML 1.3\n---\nx: yes",
      "x: .inf",
      "x: -.Inf",
      "x: .NaN",
      "x: 1e999",
      "SECRET: [oops",
      "x: *SECRET",
    ])
      rejects(source);
    expect(() => parseYamlValue(Uint8Array.from([0xc3, 0x28]))).toThrow(
      ArtifactReadError,
    );
  });

  it("resolves string mapping-key aliases and preserves hostile own keys", () => {
    expect(parse("a: &key key\n*key : value")).toEqual({
      a: "key",
      key: "value",
    });
    const source = bytes(
      "names: [&proto __proto__, &ctor constructor, &str toString]\n*proto : {polluted: true}\n*ctor : ordinary\n*str : data",
    );
    const value = parseYamlValue(source) as Record<string, unknown>;
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.hasOwn({}, "polluted")).toBe(false);
    const projected = queryYaml(source, {
      path: "$",
      fields: ["__proto__", "constructor", "toString"],
    }).items[0];
    expect(JSON.stringify(projected)).toBe(
      '{"__proto__":{"polluted":true},"constructor":"ordinary","toString":"data"}',
    );
  });

  it("rejects duplicate resolved mapping names and invalid key alias targets", () => {
    for (const source of [
      "name: &key duplicate\n*key : first\nduplicate: second",
      "name: &key duplicate\nduplicate: first\n*key : second",
      "names: [&one duplicate, &two duplicate]\n*one : first\n*two : second",
      "*SECRET : value",
      "name: &key 1\n*key : value",
      "name: &key true\n*key : value",
      "name: &key null\n*key : value",
      "name: &key [text]\n*key : value",
      "name: &key {text: value}\n*key : value",
      "root: &root {*root : value}",
      "name: &key text\n*key : &cycle [*cycle]",
    ])
      rejects(source);
  });

  it("counts mapping-key and value aliases together without charging names as value nodes", () => {
    const combined = (values: number) =>
      `name: &key resolved\n*key : [${Array(values).fill("*key").join(",")}]`;
    const value = parse(combined(99)) as { resolved: string[] };
    expect(value.resolved).toHaveLength(99);
    expect(value.resolved[98]).toBe("resolved");
    rejects(combined(100), "resource_limit");
    const keys = (count: number) =>
      `name: &key resolved\nrows:\n${Array(count).fill("  - *key : value").join("\n")}`;
    expect((parse(keys(100)) as { rows: unknown[] }).rows).toHaveLength(100);
    rejects(keys(101), "resource_limit");
    const boundary = `name: &key resolved\n*key : [${Array(199_997).fill("0").join(",")}]`;
    expect((parse(boundary) as { resolved: number[] }).resolved).toHaveLength(
      199_997,
    );
  });

  it("yaml_alias_cycles_and_counts_fail_before_expansion", () => {
    const aliases = (count: number) =>
      `a: &a [one]\nb: [${Array(count).fill("*a").join(",")}]`;
    const value = parse(aliases(100)) as { b: string[][] };
    expect(value.b).toHaveLength(100);
    expect(value.b[99]).toEqual(["one"]);
    rejects(aliases(101), "resource_limit");
    rejects("a: &a [*a]");
    rejects("a: &a { b: &b [*a] }");
    const bomb = ["a0: &a0 [0,0]"];
    for (let i = 1; i <= 18; i++)
      bomb.push(`a${i}: &a${i} [*a${i - 1},*a${i - 1}]`);
    rejects(bomb.join("\n"), "resource_limit");
  });

  it("yaml_enforces_depth_and_normalized_node_limits", () => {
    const deep = (depth: number) => "[".repeat(depth) + "0" + "]".repeat(depth);
    expect(Array.isArray(parse(deep(512)))).toBe(true);
    rejects(deep(513), "resource_limit");
    expect(parse(`[${Array(199_999).fill("0").join(",")}]`)).toHaveLength(
      199_999,
    );
    rejects(`[${Array(200_000).fill("0").join(",")}]`, "resource_limit");
    const repeated = (size: number) =>
      `a: &a [${Array(size).fill("0").join(",")}]\nb: [${Array(100).fill("*a").join(",")}]`;
    expect((parse(repeated(1979)) as { b: unknown[] }).b).toHaveLength(100);
    rejects(repeated(1980), "resource_limit");
    const aliasDeep = `a: &a ${deep(511)}\nb: [*a]`;
    rejects(aliasDeep, "resource_limit");
  });

  it("preserves hostile keys as own data during normalization, query and projection", () => {
    const source = bytes(
      "__proto__: {polluted: true}\nconstructor: ordinary\ntoString: data",
    );
    const value = parseYamlValue(source) as Record<string, unknown>;
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(Object.hasOwn({}, "polluted")).toBe(false);
    expect(queryYaml(source, { path: "$.__proto__.polluted" }).items).toEqual([
      true,
    ]);
    const projected = queryYaml(source, {
      path: "$",
      fields: ["__proto__", "constructor", "toString"],
    }).items[0]!;
    expect(Object.hasOwn(projected as object, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(projected)).toBe(Object.prototype);
    expect(JSON.stringify(projected)).toBe(
      '{"__proto__":{"polluted":true},"constructor":"ordinary","toString":"data"}',
    );
    expect(
      queryYaml(bytes("a: {}"), { path: "$.a.constructor" }).items,
    ).toEqual([]);
  });

  it("query_yaml_retains_json_filters_and_projection", () => {
    const source = bytes(
      "items:\n  - name: first\n    score: 1\n    nested: {state: ready}\n  - name: second\n    score: 2\n    nested: {state: waiting}\n",
    );
    expect(
      queryYaml(source, {
        path: "$.items[?(@.score >= 1 && @.name contains 's')]",
        fields: ["name", "nested.state"],
        offset: 1,
        limit: 1,
      }),
    ).toEqual({
      path: "$.items[?(@.score >= 1 && @.name contains 's')]",
      total: 2,
      offset: 1,
      limit: 1,
      truncated: false,
      items: [{ name: "second", "nested.state": "waiting" }],
    });
    expect(queryYaml(source, { path: "$.items[1:].length" }).items).toEqual([
      1,
    ]);
    expect(queryYaml(source, { path: "$.items[1:]" }).items).toEqual([
      [{ name: "second", score: 2, nested: { state: "waiting" } }],
    ]);
    expect(readYamlOverview(source)).toEqual({
      sizeBytes: source.length,
      topLevel: [{ key: "items", type: "array", count: 2 }],
      truncated: false,
      rootType: "object",
      rootCount: 1,
    });
    expect(() => queryYaml(source, { path: "bad" })).toThrow(ArtifactReadError);
  });
});
