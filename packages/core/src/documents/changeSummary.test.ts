import { describe, expect, it } from "vitest";
import { providerError, validationError } from "../ai/http";
import {
  buildChangeSummaryPrompt,
  CHANGE_SUMMARY_SYSTEM,
  changeSummaryBudget,
  classifyChangeSummaryFailure,
  usableSummary,
} from "./changeSummary";

const systemBytes = Buffer.byteLength(CHANGE_SUMMARY_SYSTEM);

describe("change summary prompt", () => {
  it("keeps nearby wording and both titles but not unchanged paragraphs", () => {
    const prompt = buildChangeSummaryPrompt(
      {
        title: "Old title",
        markdown:
          "Unchanged paragraph\n\nThe request timeout is 10 seconds.\n\nAnother paragraph",
      },
      {
        title: "New title",
        markdown:
          "Unchanged paragraph\n\nThe request timeout is 20 seconds.\n\nAnother paragraph",
      },
      8_000,
    );
    expect(prompt).toContain("Old title");
    expect(prompt).toContain("New title");
    expect(prompt).toContain("The request timeout is 10 seconds.");
    expect(prompt).toContain("The request timeout is 20 seconds.");
    expect(prompt).not.toContain("Unchanged paragraph");
    expect(CHANGE_SUMMARY_SYSTEM).toContain("English");
  });

  it("caps multilingual prompts to the byte budget", () => {
    const budget = changeSummaryBudget({
      contextWindow: 2_500,
      maxOutputTokens: 64,
    });
    expect(budget?.maxOutputTokens).toBe(64);
    const prompt = buildChangeSummaryPrompt(
      { title: "Title", markdown: "" },
      { title: "Title", markdown: "界".repeat(100_000) },
      budget!.maxPromptBytes,
    );
    expect(
      Buffer.byteLength(prompt) + systemBytes + 64 + 512,
    ).toBeLessThanOrEqual(2_500);
  });

  it("uses a conservative budget without context metadata and leaves room for reasoning", () => {
    const unknown = changeSummaryBudget({ contextWindow: null });
    expect(unknown?.maxOutputTokens).toBe(1_024);
    expect(
      unknown!.maxPromptBytes + systemBytes + 512 + 1_024,
    ).toBeLessThanOrEqual(4_096);
    expect(
      changeSummaryBudget({ contextWindow: 1_048_576, maxOutputTokens: 65_536 })
        ?.maxOutputTokens,
    ).toBe(2_048);
    expect(changeSummaryBudget({ contextWindow: 256 })).toBeNull();
  });

  it.each([
    "",
    "a".repeat(121),
    "First\nSecond",
    "unsafe\u0000comment",
    "```summary```",
    "**Clarify the title**",
    "_Clarify the title_",
    "# Clarify the title",
    "- Clarify the title",
    "[Clarify the title](https://example.test)",
    '{"summary":"Clarify the title"}',
    '["Clarify the title"]',
    '"Clarify the title"',
    "'Clarify the title'",
    "“Clarify the title”",
  ])("rejects unusable output %j", (text) => {
    expect(usableSummary(text)).toBeNull();
  });

  it("accepts and trims a plain line", () => {
    expect(usableSummary("  Clarify the rollback steps ")).toBe(
      "Clarify the rollback steps",
    );
  });
});

describe("classifyChangeSummaryFailure", () => {
  it("distinguishes timeouts, provider statuses, validation, and unknown errors", () => {
    expect(
      classifyChangeSummaryFailure(
        providerError("AI provider request timed out", true),
      ),
    ).toEqual({ reason: "timeout", retryable: true, statusCode: null });
    expect(
      classifyChangeSummaryFailure(
        providerError("AI provider request failed with status 503", true),
      ),
    ).toEqual({ reason: "provider", retryable: true, statusCode: 503 });
    expect(
      classifyChangeSummaryFailure(
        providerError("AI provider request failed with status 400", false),
      ),
    ).toEqual({ reason: "provider", retryable: false, statusCode: 400 });
    expect(
      classifyChangeSummaryFailure(
        validationError("AI provider returned invalid completion"),
      ),
    ).toEqual({ reason: "validation", retryable: false, statusCode: null });
    expect(classifyChangeSummaryFailure(new Error("key ring missing"))).toEqual(
      { reason: "provider", retryable: false, statusCode: null },
    );
  });
});
