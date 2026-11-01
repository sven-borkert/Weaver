import { describe, expect, it } from "vitest";
import { ArtifactReadError } from "./errors";
import { queryJsonPath, type JsonValue } from "./jsonPath";
import {
  queryJson,
  readJsonOverview,
  overviewJsonValue,
  queryJsonValue,
} from "./json";

const FIXTURE: JsonValue = {
  metadata: {
    export_time: "2026-07-18 00:00:00 UTC+0000",
    target_account: "test-account",
    target_region: "eu-central-1",
  },
  security_groups: [
    { GroupId: "sg-aaa", GroupName: "web-sg", FromPort: 443 },
    { GroupId: "sg-bbb", GroupName: "app-sg" },
    { GroupId: "sg-ccc", GroupName: "db-sg", FromPort: 5432 },
  ],
};

const fixtureBytes = () => new TextEncoder().encode(JSON.stringify(FIXTURE));

function readCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ArtifactReadError);
    return (e as ArtifactReadError).code;
  }
  throw new Error("expected the function to throw");
}

describe("readJsonOverview", () => {
  it("lists top-level keys with counts", () => {
    const bytes = fixtureBytes();
    const overview = readJsonOverview(bytes);
    expect(overview.sizeBytes).toBe(bytes.length);
    const sg = overview.topLevel.find((e) => e.key === "security_groups");
    expect(sg).toMatchObject({ type: "array", count: 3 });
    const meta = overview.topLevel.find((e) => e.key === "metadata");
    expect(meta).toMatchObject({ type: "object", count: 3 });
    expect(overview.rootType).toBe("object");
    expect(overview.rootCount).toBe(2);
  });

  it("lists top-level keys with counts for an arbitrary object", () => {
    const bytes = new TextEncoder().encode('{"a":[1,2]}');
    const overview = readJsonOverview(bytes);
    expect(overview.topLevel).toEqual([{ key: "a", type: "array", count: 2 }]);
    expect(overview.rootType).toBe("object");
    expect(overview.rootCount).toBe(1);
  });

  it("reports rootType array, empty topLevel, and rootCount for a top-level array", () => {
    const bytes = new TextEncoder().encode(JSON.stringify([1, 2, 3]));
    const overview = readJsonOverview(bytes);
    expect(overview.topLevel).toEqual([]);
    expect(overview.rootType).toBe("array");
    expect(overview.rootCount).toBe(3);
  });

  it("reports rootType and null rootCount for a scalar root", () => {
    const bytes = new TextEncoder().encode("42");
    const overview = readJsonOverview(bytes);
    expect(overview.topLevel).toEqual([]);
    expect(overview.rootType).toBe("number");
    expect(overview.rootCount).toBeNull();
  });

  it("caps topLevel at 5,000 keys and says so", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 5_001 }, (_value, index) => [`k${index}`, index]),
    );
    const overview = readJsonOverview(
      new TextEncoder().encode(JSON.stringify(wide)),
    );
    expect(overview.truncated).toBe(true);
    expect(overview.topLevel).toHaveLength(5_000);
    expect(overview.topLevel.at(-1)).toEqual({
      key: "k4999",
      type: "number",
      count: null,
    });
    expect(overview.rootCount).toBe(5_001);
    expect(readJsonOverview(fixtureBytes()).truncated).toBe(false);
  });

  it("throws malformed for invalid JSON bytes", () => {
    const bytes = new TextEncoder().encode("{nope");
    expect(readCode(() => readJsonOverview(bytes))).toBe("malformed");
  });

  it("throws malformed for invalid UTF-8 bytes", () => {
    const bytes = Uint8Array.from([0xc3, 0x28]); // invalid 2-byte sequence
    expect(readCode(() => readJsonOverview(bytes))).toBe("malformed");
  });
});

describe("queryJson", () => {
  it("returns paginated matches with totals", () => {
    const all = queryJson(fixtureBytes(), {
      path: "$.security_groups[*].GroupName",
    });
    expect(all).toMatchObject({
      total: 3,
      offset: 0,
      limit: 50,
      truncated: false,
      items: ["web-sg", "app-sg", "db-sg"],
    });
    const page = queryJson(fixtureBytes(), {
      path: "$.security_groups[*].GroupName",
      limit: 1,
    });
    expect(page).toMatchObject({
      total: 3,
      limit: 1,
      truncated: true,
      items: ["web-sg"],
    });
    const second = queryJson(fixtureBytes(), {
      path: "$.security_groups[*].GroupName",
      offset: 1,
      limit: 1,
    });
    expect(second.items).toEqual(["app-sg"]);
    expect(second.truncated).toBe(true);
  });

  it("clamps limit above 200 down to 200", () => {
    const res = queryJson(fixtureBytes(), {
      path: "$.security_groups[*].GroupId",
      limit: 999,
    });
    expect(res.limit).toBe(200);
  });

  it("returns empty with truncated false when offset is beyond the end", () => {
    const beyond = queryJson(fixtureBytes(), {
      path: "$.security_groups[*].GroupName",
      offset: 99,
    });
    expect(beyond).toMatchObject({ items: [], truncated: false, total: 3 });
  });

  it("maps a path missing $ to invalid_path and a path with no matches to an empty total", () => {
    expect(() => queryJson(fixtureBytes(), { path: "nope" })).toThrowError(
      /Path must start/,
    );
    expect(readCode(() => queryJson(fixtureBytes(), { path: "nope" }))).toBe(
      "invalid_path",
    );
    expect(queryJson(fixtureBytes(), { path: "$.does.not.exist" }).total).toBe(
      0,
    );
  });

  it("maps a malformed JSONPath to invalid_path with the parser's own message", () => {
    let expectedMessage = "";
    try {
      queryJsonPath(FIXTURE, "$..[");
    } catch (e) {
      expectedMessage = (e as Error).message;
    }
    expect(expectedMessage).not.toBe("");
    try {
      queryJson(fixtureBytes(), { path: "$..[" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ArtifactReadError);
      expect((e as ArtifactReadError).code).toBe("invalid_path");
      expect((e as ArtifactReadError).message).toBe(expectedMessage);
    }
  });

  it("throws malformed for invalid JSON bytes", () => {
    const bytes = new TextEncoder().encode("{nope");
    expect(readCode(() => queryJson(bytes, { path: "$" }))).toBe("malformed");
  });

  it("throws malformed for invalid UTF-8 bytes", () => {
    const bytes = Uint8Array.from([0xc3, 0x28]);
    expect(readCode(() => queryJson(bytes, { path: "$" }))).toBe("malformed");
  });

  it("rejects more than 20 fields with resource_limit", () => {
    const fields = Array.from({ length: 21 }, (_, i) => `f${i}`);
    try {
      queryJson(fixtureBytes(), { path: "$.security_groups[*]", fields });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ArtifactReadError);
      expect((e as ArtifactReadError).code).toBe("resource_limit");
      expect((e as ArtifactReadError).message).toContain("at most 20 fields");
    }
  });

  it("keeps a single oversized first match, flagged truncated, so a page can still advance", () => {
    const doc: JsonValue = {
      blob: "x".repeat(200 * 1024),
      after: ["small", "y".repeat(200 * 1024)],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(doc));
    const res = queryJson(bytes, { path: "$.blob" });
    expect(res).toMatchObject({ truncated: true, total: 1 });
    expect(res.items).toHaveLength(1);
    expect((res.items[0] as string).length).toBe(200 * 1024);
    // An oversized item that is not the first of its page is left for the next one.
    const later = queryJson(bytes, { path: "$.after[*]" });
    expect(later).toMatchObject({
      items: ["small"],
      truncated: true,
      total: 2,
    });
    expect(queryJson(bytes, { path: "$.after[*]", offset: 1 }).items).toEqual([
      "y".repeat(200 * 1024),
    ]);
  });

  it("keeps as many items as fit under the byte budget", () => {
    const doc: JsonValue = {
      arr: Array.from({ length: 10 }, () => "x".repeat(20 * 1024)),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(doc));
    const res = queryJson(bytes, { path: "$.arr[*]" });
    expect(res.total).toBe(10);
    expect(res.truncated).toBe(true);
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items.length).toBeLessThan(10);
    expect(JSON.stringify(res.items).length).toBeLessThan(128 * 1024 + 64);
  });

  it("leaves small results unclipped", () => {
    const res = queryJson(fixtureBytes(), {
      path: "$.security_groups[*].GroupName",
    });
    expect(res.truncated).toBe(false);
    expect(res.items).toEqual(["web-sg", "app-sg", "db-sg"]);
  });

  it("yields a slice as one match, with .length readable on it", () => {
    const sliceRes = queryJson(fixtureBytes(), {
      path: "$.security_groups[1:]",
    });
    expect(sliceRes.items).toEqual([
      [
        { GroupId: "sg-bbb", GroupName: "app-sg" },
        { GroupId: "sg-ccc", GroupName: "db-sg", FromPort: 5432 },
      ],
    ]);
    const lengthRes = queryJson(fixtureBytes(), {
      path: "$.security_groups[1:].length",
    });
    expect(lengthRes.items).toEqual([2]);
  });

  describe("filter operators", () => {
    it("==", () => {
      expect(
        queryJson(fixtureBytes(), {
          path: "$.security_groups[?(@.GroupName == 'app-sg')].GroupId",
        }).items,
      ).toEqual(["sg-bbb"]);
    });

    it("!=", () => {
      expect(
        queryJson(fixtureBytes(), {
          path: "$.security_groups[?(@.GroupName != 'app-sg')].GroupId",
        }).items,
      ).toEqual(["sg-aaa", "sg-ccc"]);
    });

    it("<", () => {
      expect(
        queryJson(fixtureBytes(), {
          path: "$.security_groups[?(@.FromPort < 1000)].GroupId",
        }).items,
      ).toEqual(["sg-aaa"]);
    });

    it("<=", () => {
      expect(
        queryJson(fixtureBytes(), {
          path: "$.security_groups[?(@.FromPort <= 443)].GroupId",
        }).items,
      ).toEqual(["sg-aaa"]);
    });

    it(">", () => {
      expect(
        queryJson(fixtureBytes(), {
          path: "$.security_groups[?(@.FromPort > 1000)].GroupId",
        }).items,
      ).toEqual(["sg-ccc"]);
    });

    it(">=", () => {
      expect(
        queryJson(fixtureBytes(), {
          path: "$.security_groups[?(@.FromPort >= 443)].GroupId",
        }).items,
      ).toEqual(["sg-aaa", "sg-ccc"]);
    });

    it("contains", () => {
      expect(
        queryJson(fixtureBytes(), {
          path: "$.security_groups[?(@.GroupName contains 'db')].GroupId",
        }).items,
      ).toEqual(["sg-ccc"]);
    });

    it("&&", () => {
      expect(
        queryJson(fixtureBytes(), {
          path: "$.security_groups[?(@.GroupName contains 'sg' && @.FromPort >= 1000)].GroupId",
        }).items,
      ).toEqual(["sg-ccc"]);
    });

    it("bare existence", () => {
      expect(
        queryJson(fixtureBytes(), {
          path: "$.security_groups[?(@.FromPort)].GroupId",
        }).items,
      ).toEqual(["sg-aaa", "sg-ccc"]);
    });
  });

  describe("fields projection", () => {
    const doc: JsonValue = {
      items: [
        { Name: "a", State: { Code: "active" }, Tags: [{ Key: "x" }] },
        { Name: "b" },
      ],
      scalars: ["plain-string", 7],
    };
    const bytes = () => new TextEncoder().encode(JSON.stringify(doc));

    it("projects object matches down to the requested dot-paths", () => {
      const res = queryJson(bytes(), {
        path: "$.items[*]",
        fields: ["Name", "State.Code", "Missing.Key"],
      });
      expect(res.items).toEqual([
        { Name: "a", "State.Code": "active" },
        { Name: "b" },
      ]);
    });

    it("passes non-object matches through unchanged", () => {
      const res = queryJson(bytes(), {
        path: "$.scalars[*]",
        fields: ["Name"],
      });
      expect(res.items).toEqual(["plain-string", 7]);
    });

    it("a path segment applied to an array yields a missing field", () => {
      const res = queryJson(bytes(), {
        path: "$.items[0]",
        fields: ["Tags.Key", "Name"],
      });
      expect(res.items).toEqual([{ Name: "a" }]);
    });
  });

  it("maps a match-cap overflow to resource_limit with the fixed message", () => {
    const doc: JsonValue = {
      big: Array.from({ length: 200_001 }, (_, i) => i),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(doc));
    try {
      queryJson(bytes, { path: "$.big[*]" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ArtifactReadError);
      expect((e as ArtifactReadError).code).toBe("resource_limit");
      expect((e as ArtifactReadError).message).toBe(
        "query matches too many values; narrow the path",
      );
    }
  });
});

describe("extremely deep documents", () => {
  /** JSON.parse handles this depth; JSON.stringify (the byte-budget clip)
   *  overflows the stack around 20,000. */
  const deepBytes = (depth: number) =>
    new TextEncoder().encode(`${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`);

  it("maps a stack overflow to resource_limit instead of a raw RangeError", () => {
    const bytes = deepBytes(50_000);
    expect(readCode(() => queryJson(bytes, { path: "$" }))).toBe(
      "resource_limit",
    );
  });
});

describe("no document content in error messages", () => {
  it("never quotes the artifact bytes in a malformed-JSON message", () => {
    const bytes = new TextEncoder().encode("SECRET_TOKEN=abc123 leaked");
    try {
      readJsonOverview(bytes);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ArtifactReadError);
      expect((e as ArtifactReadError).code).toBe("malformed");
      expect((e as ArtifactReadError).message).not.toContain("SECRET");
    }
    try {
      queryJson(bytes, { path: "$" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ArtifactReadError);
      expect((e as ArtifactReadError).code).toBe("malformed");
      expect((e as ArtifactReadError).message).not.toContain("SECRET");
    }
  });
});

describe("shared normalized JSON model", () => {
  it("preserves overview and query results without reparsing", () => {
    expect(overviewJsonValue(FIXTURE, fixtureBytes().length)).toEqual(
      readJsonOverview(fixtureBytes()),
    );
    for (const input of [
      {
        path: "$.security_groups[*]",
        fields: ["GroupName"],
        offset: 1,
        limit: 1,
      },
      { path: "$.security_groups[1:]" },
      { path: "$.security_groups[?(@.FromPort >= 443)].GroupId" },
    ])
      expect(queryJsonValue(FIXTURE, input)).toEqual(
        queryJson(fixtureBytes(), input),
      );
  });
  it("projects a literal __proto__ key without changing the result prototype", () => {
    const result = queryJson(
      new TextEncoder().encode('{"__proto__":{"value":1}}'),
      { path: "$", fields: ["__proto__"] },
    );
    expect(JSON.stringify(result.items)).toBe('[{"__proto__":{"value":1}}]');
  });
});
