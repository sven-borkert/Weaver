import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatTokens,
  replyUsageLine,
  sessionUsageLine,
} from "./usageFormat";

describe("assistant usage formatting", () => {
  it("shortens token counts and durations", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_340)).toBe("12.3k");
    expect(formatTokens(1_048_576)).toBe("1.0M");
    expect(formatDuration(400)).toBe("1 s");
    expect(formatDuration(83_000)).toBe("1 min 23 s");
  });
  it("summarises a session and a reply", () => {
    expect(
      sessionUsageLine({
        totals: {
          replies: 1,
          toolCalls: 4,
          inputTokens: 23_400,
          outputTokens: 800,
        },
      }),
    ).toBe("1 reply · 4 tool calls · 23.4k in / 800 out tokens");
    expect(
      sessionUsageLine({
        totals: { replies: 2, toolCalls: 1, inputTokens: 0, outputTokens: 0 },
      }),
    ).toBe("2 replies · 1 tool call · 0 in / 0 out tokens");
    expect(
      replyUsageLine({
        model: "kimi-k3",
        inputTokens: 11_259,
        outputTokens: 601,
        toolCalls: 0,
        durationMs: 7_940,
      }),
    ).toBe("kimi-k3 · 0 tool calls · 11.3k in / 601 out tokens · 8 s");
  });
  it("leaves out what is unknown", () => {
    expect(
      replyUsageLine({
        model: null,
        inputTokens: null,
        outputTokens: null,
        toolCalls: null,
        durationMs: 2_000,
      }),
    ).toBe("2 s");
  });
});
