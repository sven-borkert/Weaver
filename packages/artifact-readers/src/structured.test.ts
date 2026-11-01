import { describe, expect, it } from "vitest";
import { inspectStructuredValue } from "./structured";
import { inspectJson, queryJsonValue, type JsonValue } from "./json";
import { inspectYaml } from "./yaml";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("structured artifact inspection", () => {
  it("pointer_escapes_slashes_tildes_dots_and_special_keys", () => {
    const value = JSON.parse(
      '{"a/b":{"~.key":1},"__proto__":2,"constructor":3,"":4}',
    ) as JsonValue;
    Object.defineProperty(value, "'\"\\\n\r\t\u0000]", {
      value: 5,
      enumerable: true,
    });
    const result = inspectStructuredValue(value, {});
    expect(result.nodes.map((node) => node.pointer)).toContain("/a~1b/~0.key");
    expect(
      result.nodes.find((node) => node.pointer === "/a~1b/~0.key")?.queryPath,
    ).toBe("$['a/b']['~.key']");
    for (const node of result.nodes) {
      const selected = inspectStructuredValue(value, {
        pointer: node.pointer,
        depth: 1,
        includeSamples: true,
      });
      const query = queryJsonValue(value, { path: node.queryPath });
      expect(query.items).toHaveLength(1);
      if (node.childCount === null)
        expect(query.items).toEqual(selected.nodes[0]?.samples);
      expect(selected.nodes[0]?.queryPath).toBe(node.queryPath);
    }
    expect(
      inspectStructuredValue(value, { pointer: "/", includeSamples: true })
        .nodes[0]?.samples,
    ).toEqual([4]);
    for (const pointer of ["a", "/~", "/~2", "/toString", "/a~1b/missing"]) {
      expect(() => inspectStructuredValue(value, { pointer })).toThrow(
        expect.objectContaining({ code: "invalid_path" }),
      );
    }
  });

  it("wide_nested_structure_pages_reach_last_key", () => {
    const nested = Object.fromEntries(
      Array.from({ length: 5101 }, (_, i) => [
        `key-${String(i).padStart(4, "0")}`,
        i,
      ]),
    );
    const value = { z: null, a: nested };
    let offset = 0;
    const pointers: string[] = [];
    do {
      const page = inspectStructuredValue(value, { offset, limit: 200 });
      expect(page.total).toBe(5104);
      pointers.push(...page.nodes.map((node) => node.pointer));
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    } while (true);
    expect(pointers).toHaveLength(5104);
    expect(new Set(pointers).size).toBe(5104);
    expect(pointers.slice(-2)).toEqual(["/a/key-5100", "/z"]);
    expect(inspectStructuredValue(value, { offset: 5104 }).nodes).toEqual([]);
  });

  it("heterogeneous_array_reports_first_twenty_as_sampled", () => {
    const value: JsonValue = [
      null,
      true,
      "text",
      7,
      {},
      [],
      ...Array.from({ length: 15 }, () => 0),
      { hidden: "later" },
    ];
    const result = inspectStructuredValue(value, {});
    expect(result.total).toBe(21);
    expect(result.nodes[0]).toEqual({
      pointer: "",
      queryPath: "$",
      type: "array",
      childCount: 22,
      sampled: true,
      sampledCount: 20,
    });
    expect(result.nodes.slice(1, 7).map((node) => node.type)).toEqual([
      "null",
      "boolean",
      "string",
      "number",
      "object",
      "array",
    ]);
    expect(result.nodes.at(-1)?.pointer).toBe("/19");
    expect(inspectStructuredValue([], {}).nodes[0]).toMatchObject({
      childCount: 0,
      sampled: false,
      sampledCount: 0,
    });
  });

  it("exact_array_element_beyond_sample_is_inspectable", () => {
    const value = {
      list: Array.from({ length: 100 }, (_, i) => ({ number: i })),
    };
    expect(
      inspectStructuredValue(value, {
        pointer: "/list/99",
        includeSamples: true,
      }),
    ).toMatchObject({
      pointer: "/list/99",
      total: 2,
      nodes: [
        { pointer: "/list/99", queryPath: "$['list'][99]", childCount: 1 },
        { pointer: "/list/99/number", samples: [99] },
      ],
    });
    for (const pointer of [
      "/list/01",
      "/list/-1",
      "/list/-",
      "/list/100",
      "/list/length",
      "/list/1.0",
      "/list/1/number/x",
    ]) {
      expect(() => inspectStructuredValue(value, { pointer })).toThrow(
        expect.objectContaining({ code: "invalid_path" }),
      );
    }
  });

  it("values_omitted_unless_requested_and_samples_are_byte_bounded", () => {
    const huge = "😀".repeat(100_000);
    const value = { a: huge, b: "é".repeat(41), c: false, d: null };
    const shape = inspectStructuredValue(value, {});
    expect(JSON.stringify(shape)).not.toContain(huge);
    expect(
      shape.nodes.every(
        (node) => !("samples" in node) && !("samplesTruncated" in node),
      ),
    ).toBe(true);
    const samples = inspectStructuredValue(value, { includeSamples: true });
    expect(samples.nodes[0]?.samples).toEqual([
      "😀".repeat(20),
      "é".repeat(40),
      false,
    ]);
    expect(samples.nodes[0]?.samplesTruncated).toBe(true);
    expect(samples.nodes[1]?.samplesTruncated).toBe(true);
    expect(samples.nodes.at(-1)?.samples).toEqual([null]);
    for (const node of samples.nodes) {
      expect(node.samples?.length ?? 0).toBeLessThanOrEqual(3);
      for (const sample of node.samples ?? [])
        if (typeof sample === "string")
          expect(Buffer.byteLength(sample)).toBeLessThanOrEqual(80);
    }
  });

  it("defaults_depth_and_page_size_and_rejects_hard_maxima", () => {
    const value = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    expect(
      inspectStructuredValue(value, {}).nodes.map((node) => node.pointer),
    ).toEqual(["", "/a", "/a/b"]);
    expect(
      inspectStructuredValue(value, { depth: 5 }).nodes.at(-1)?.pointer,
    ).toBe("/a/b/c/d/e");
    expect(
      inspectStructuredValue(value, { pointer: "/a/b/c/d", depth: 2 }).nodes.at(
        -1,
      )?.pointer,
    ).toBe("/a/b/c/d/e/f");
    expect(inspectStructuredValue(Array(100).fill(0), {}).nodes).toHaveLength(
      21,
    );
    expect(
      inspectStructuredValue(
        Object.fromEntries(Array.from({ length: 100 }, (_, i) => [i, null])),
        {},
      ).nodes,
    ).toHaveLength(50);
    for (const input of [
      { depth: 6 },
      { depth: -1 },
      { depth: 1.1 },
      { depth: NaN },
      { limit: 201 },
      { limit: 0 },
      { offset: -1 },
      { offset: 0.1 },
    ]) {
      expect(() => inspectStructuredValue(value, input)).toThrow(
        expect.objectContaining({ code: "invalid_input" }),
      );
    }
  });

  it("depth_zero_inspects_only_the_selected_root", () => {
    expect(
      inspectStructuredValue({ a: { b: 1 } }, { pointer: "/a", depth: 0 }),
    ).toMatchObject({
      total: 1,
      nodes: [{ pointer: "/a", childCount: 1 }],
      nextOffset: null,
    });
  });

  it("address_budget_preserves_exact_boundaries_and_is_page_local", () => {
    const boundaryKey = "/" + "x".repeat(4077);
    const boundary = inspectStructuredValue({ [boundaryKey]: 1 }, { offset: 1 })
      .nodes[0]!;
    expect(
      Buffer.byteLength(
        JSON.stringify({
          pointer: boundary.pointer,
          queryPath: boundary.queryPath,
        }),
      ),
    ).toBe(8192);
    expect(
      queryJsonValue({ [boundaryKey]: 1 }, { path: boundary.queryPath }).items,
    ).toEqual([1]);
    const longKey = "b".repeat(5000);
    const value = { a: 1, [longKey]: 2, z: 3 };
    expect(inspectStructuredValue(value, { limit: 2 })).toMatchObject({
      total: 4,
      nextOffset: 2,
    });
    expect(() =>
      inspectStructuredValue(value, { offset: 2, limit: 1 }),
    ).toThrow(expect.objectContaining({ code: "resource_limit" }));
    expect(inspectStructuredValue(value, { offset: 3 }).nodes[0]?.pointer).toBe(
      "/z",
    );
    expect(() =>
      inspectStructuredValue({ ["\u0000".repeat(680)]: 1 }, { offset: 1 }),
    ).toThrow(expect.objectContaining({ code: "resource_limit" }));
  });

  it("json_and_yaml_wrappers_share_the_selected_structure_model", () => {
    const input = { pointer: "/root/a.b", includeSamples: true };
    expect(
      inspectJson(bytes('{"root":{"a.b":[1,"two",null]}}'), input),
    ).toEqual(inspectYaml(bytes("root:\n  a.b: [1, two, null]\n"), input));
    expect(() => inspectJson(bytes("invalid secret"), {})).toThrow(
      expect.objectContaining({ code: "malformed" }),
    );
    expect(() => inspectYaml(bytes("a: !secret value"), {})).toThrow(
      expect.objectContaining({ code: "malformed" }),
    );
  });

  it("empty_pages_bound_the_selected_pointer_including_json_escaping", () => {
    const boundaryKey = "/" + "x".repeat(4077);
    expect(
      inspectStructuredValue(
        { [boundaryKey]: 1 },
        {
          pointer: "/~1" + "x".repeat(4077),
          depth: 0,
          offset: 1,
        },
      ),
    ).toEqual({
      pointer: "/~1" + "x".repeat(4077),
      total: 1,
      offset: 1,
      nodes: [],
      nextOffset: null,
    });
    for (const key of [
      "x".repeat(2 * 1024 * 1024),
      "\u0000".repeat(680),
      "/" + "x".repeat(4078),
    ]) {
      const pointer = "/" + key.replace(/\//g, "~1");
      expect(() =>
        inspectStructuredValue({ [key]: 1 }, { pointer, depth: 0, offset: 1 }),
      ).toThrow(
        expect.objectContaining({
          code: "resource_limit",
          message:
            "structure node addresses exceed 8192 UTF-8 bytes; inspect a different pointer or page, or use raw-source reads",
        }),
      );
    }
  });
});
