import { describe, expect, it } from "vitest";
import { CoreError } from "@weaver/core/errors";
import {
  boundItems,
  clampText,
  MAX_TOOL_OUTPUT_CHARS,
  newOutputBudget,
  ToolError,
  toolErrorFromUnknown,
  truncatedToolOutput,
  utf8Bytes,
  utf8Prefix,
} from "./contract";

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const endsInLoneSurrogate = (text: string) => {
  const code = text.charCodeAt(text.length - 1);
  return code >= 0xd800 && code <= 0xdbff;
};

describe("toolErrorFromUnknown", () => {
  it("maps core errors, keeps scope violations distinct, and hides internals", () => {
    expect(
      toolErrorFromUnknown(
        new CoreError("FORBIDDEN", "SCOPE_VIOLATION", {
          reason: "SCOPE_VIOLATION",
        }),
      ).code,
    ).toBe("SCOPE_VIOLATION");
    expect(toolErrorFromUnknown(new CoreError("FORBIDDEN")).code).toBe(
      "FORBIDDEN",
    );
    expect(toolErrorFromUnknown(new CoreError("NOT_FOUND")).code).toBe(
      "NOT_FOUND",
    );
    expect(
      toolErrorFromUnknown(new CoreError("PRECONDITION_FAILED", "x")).code,
    ).toBe("CONFLICT");
    const internal = toolErrorFromUnknown(new Error("secret-bearing stack"));
    expect(internal).toBeInstanceOf(ToolError);
    expect(internal.code).toBe("INTERNAL");
    expect(internal.message).not.toContain("secret");
  });

  it("tells the caller a busy reader can be retried instead of hiding it as INTERNAL", () => {
    expect(
      toolErrorFromUnknown(
        new CoreError("TOO_MANY_REQUESTS", "reader queue full (internal)"),
      ),
    ).toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: "too many file reads are in progress; try again shortly",
    });
  });

  it("maps cancellation errors to the stable cancellation code", () => {
    const aborted = new Error("request aborted");
    aborted.name = "AbortError";
    const timedOut = new Error("request timed out");
    timedOut.name = "TimeoutError";

    expect(toolErrorFromUnknown(aborted)).toMatchObject({
      code: "CANCELLED",
      message: "tool cancelled",
    });
    expect(toolErrorFromUnknown(timedOut)).toMatchObject({
      code: "CANCELLED",
      message: "tool cancelled",
    });
  });

  it("forwards allowlisted structured reasons and drops unknown ones", () => {
    expect(
      toolErrorFromUnknown(
        new CoreError("BAD_REQUEST", "cursor", { reason: "INVALID_CURSOR" }),
      ),
    ).toMatchObject({ code: "BAD_REQUEST", reason: "INVALID_CURSOR" });
    expect(
      toolErrorFromUnknown(
        new CoreError("NOT_FOUND", "snapshot", {
          reason: "SNAPSHOT_UNAVAILABLE",
        }),
      ),
    ).toMatchObject({ code: "NOT_FOUND", reason: "SNAPSHOT_UNAVAILABLE" });
    expect(
      toolErrorFromUnknown(
        new CoreError("BAD_REQUEST", "x", { reason: "SOMETHING_ELSE" }),
      ).reason,
    ).toBeUndefined();
    expect(new ToolError("BAD_REQUEST", "x").reason).toBeUndefined();
  });
});

describe("clampText", () => {
  it("truncates at the default budget and reports it", () => {
    const { text, truncated } = clampText(
      "x".repeat(MAX_TOOL_OUTPUT_CHARS + 1),
    );
    expect(text.length).toBe(MAX_TOOL_OUTPUT_CHARS);
    expect(truncated).toBe(true);
    expect(clampText("ok")).toEqual({ text: "ok", truncated: false });
  });

  it("caps a CJK page at 16,000 UTF-8 bytes, not 16,000 characters", () => {
    // 16,000 CJK characters are 48,000 bytes: three times what the prompt
    // budget charges a tool result for (packages/ai/src/prompt.ts counts bytes).
    const { text, truncated } = clampText("漢".repeat(MAX_TOOL_OUTPUT_CHARS));
    expect(truncated).toBe(true);
    expect(utf8Bytes(text)).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    expect(utf8Bytes(text)).toBeGreaterThan(MAX_TOOL_OUTPUT_CHARS - 3);
    expect(text.length).toBe(5_333);
  });

  it("never ends a clamped string in a lone surrogate", () => {
    for (const max of [1, 2, 3, 4, 5, 7, 15_999, 16_001, 16_002]) {
      const { text } = clampText("😀".repeat(8_000), max);
      expect(endsInLoneSurrogate(text)).toBe(false);
      expect(utf8Bytes(text)).toBeLessThanOrEqual(max);
      expect(text.length % 2).toBe(0);
    }
    expect(clampText("a😀", 4).text).toBe("a");
    expect(clampText("a😀", 5).text).toBe("a😀");
  });
});

describe("utf8Prefix", () => {
  it("returns the longest prefix within the byte cap on a code-point boundary", () => {
    expect(utf8Prefix("abc", 10)).toBe("abc");
    expect(utf8Prefix("héllo", 2)).toBe("h");
    expect(utf8Prefix("héllo", 3)).toBe("hé");
    expect(utf8Prefix("漢字", 3)).toBe("漢");
    expect(utf8Prefix("漢字", 5)).toBe("漢");
    expect(utf8Prefix("😀x", 3)).toBe("");
    expect(utf8Prefix("😀x", 4)).toBe("😀");
    expect(utf8Prefix("", 0)).toBe("");
  });

  it("counts a lone surrogate the way Buffer.byteLength does", () => {
    const lone = "\ud83d";
    expect(utf8Bytes(lone)).toBe(3);
    expect(utf8Prefix(`${lone}a`, 3)).toBe(lone);
    expect(utf8Prefix(`${lone}a`, 2)).toBe("");
  });
});

describe("truncatedToolOutput", () => {
  it("bounds the wrapper's own serialization, not just the payload slice", () => {
    const serialized = JSON.stringify({ text: '"\\'.repeat(20_000) });
    const wrapper = truncatedToolOutput(serialized);
    expect(wrapper.truncated).toBe(true);
    expect(serialized.startsWith(wrapper.partialJson)).toBe(true);
    const size = JSON.stringify(wrapper).length;
    expect(size).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    expect(size).toBeGreaterThan(MAX_TOOL_OUTPUT_CHARS - 8);
  });

  it("bounds the wrapper in bytes and never cuts inside a surrogate pair", () => {
    const serialized = JSON.stringify({ text: "😀漢".repeat(6_000) });
    const wrapper = truncatedToolOutput(serialized);
    expect(serialized.startsWith(wrapper.partialJson)).toBe(true);
    expect(endsInLoneSurrogate(wrapper.partialJson)).toBe(false);
    const size = bytes(wrapper);
    expect(size).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    expect(size).toBeGreaterThan(MAX_TOOL_OUTPUT_CHARS - 8);
  });
});

describe("boundItems", () => {
  it("keeps items while they fit the shared budget and reports truncation instead of dropping data silently", () => {
    const budget = newOutputBudget(20);
    // Each item serializes to `{"v":"aaaaa"}` == 13 chars + 1 separator = 14.
    const items = [{ v: "aaaaa" }, { v: "bbbbb" }, { v: "ccccc" }];
    const result = boundItems(items, budget);
    expect(result).toEqual({ items: [{ v: "aaaaa" }], truncated: true });
  });

  it("does not truncate when everything fits", () => {
    const budget = newOutputBudget();
    const items = [{ v: "a" }, { v: "b" }];
    expect(boundItems(items, budget)).toEqual({ items, truncated: false });
  });

  it("shares one budget across multiple calls, as search's document/table/entity arrays do", () => {
    const budget = newOutputBudget(20);
    const first = boundItems([{ v: "aaaaa" }], budget);
    const second = boundItems([{ v: "bbbbb" }], budget);
    expect(first).toEqual({ items: [{ v: "aaaaa" }], truncated: false });
    expect(second).toEqual({ items: [], truncated: true });
  });

  it("charges items in UTF-8 bytes so a CJK page stays within the byte budget", () => {
    const items = Array.from({ length: 100 }, () => ({ v: "漢".repeat(100) }));
    const budget = newOutputBudget(MAX_TOOL_OUTPUT_CHARS);
    const result = boundItems(items, budget);
    expect(result.truncated).toBe(true);
    // 100 CJK characters serialize to 300 bytes but only 100 characters.
    expect(result.items.length).toBeLessThan(60);
    expect(bytes(result.items)).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    expect(budget.remaining).toBeGreaterThanOrEqual(0);
  });
});

describe("slice 2 structured reasons", () => {
  it("forwards the new allowlisted reasons from CoreError details", () => {
    for (const reason of [
      "STALE_BASE",
      "AMBIGUOUS_MATCH",
      "INVALID_FINAL_STATE",
      "PAYLOAD_TOO_LARGE",
    ] as const) {
      expect(
        toolErrorFromUnknown(new CoreError("BAD_REQUEST", "no", { reason }))
          .reason,
      ).toBe(reason);
    }
  });

  it("names a missing folder instead of the generic not-found message", () => {
    const error = toolErrorFromUnknown(
      new CoreError("NOT_FOUND", "folder does not exist", {
        reason: "FOLDER_NOT_FOUND",
        field: "parentPath",
      }),
    );
    expect(error).toMatchObject({
      code: "NOT_FOUND",
      reason: "FOLDER_NOT_FOUND",
    });
    expect(error.message).toContain(
      "parentPath names a folder that does not exist",
    );
    expect(error.message).toContain("list_content_folders");
    expect(error.message).toContain("never created implicitly");
  });

  it("keeps other NOT_FOUND errors generic", () => {
    expect(
      toolErrorFromUnknown(new CoreError("NOT_FOUND", "project gone")).message,
    ).toBe("not found or not accessible");
  });

  it("still drops reasons that are not allowlisted", () => {
    expect(
      toolErrorFromUnknown(
        new CoreError("BAD_REQUEST", "no", { reason: "SOMETHING_ELSE" }),
      ).reason,
    ).toBeUndefined();
  });
});
