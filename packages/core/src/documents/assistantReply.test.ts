import { describe, expect, it } from "vitest";
import {
  formatDocumentAssistantReply,
  parseDocumentAssistantReply,
} from "./assistantReply";

describe("parseDocumentAssistantReply", () => {
  it("keeps a plain answer as the reply", () => {
    expect(
      parseDocumentAssistantReply("The formula is the logistic function."),
    ).toEqual({
      reply: "The formula is the logistic function.",
      markdown: null,
      action: null,
    });
  });

  it("separates a replacement from its explanation", () => {
    expect(
      parseDocumentAssistantReply(
        "Shorter:\n<replace_selection>\nA **short** text.\n</replace_selection>\nKept the bold.",
      ),
    ).toEqual({
      reply: "Shorter:\n\nKept the bold.",
      markdown: "A **short** text.",
      action: "replace",
    });
  });

  it("reads an insertion, unwraps a Markdown fence and keeps code fences", () => {
    expect(
      parseDocumentAssistantReply(
        "<insert>\n```markdown\n## Example\n```\n</insert>",
      ),
    ).toEqual({ reply: "", markdown: "## Example", action: "insert" });
    expect(
      parseDocumentAssistantReply("<INSERT>\n```python\nprint(1)\n```"),
    ).toEqual({
      reply: "",
      markdown: "```python\nprint(1)\n```",
      action: "insert",
    });
  });

  it("normalizes LaTeX delimiters and ignores empty tags", () => {
    expect(
      parseDocumentAssistantReply(String.raw`It is \(x^2\).<insert> </insert>`),
    ).toEqual({ reply: "It is $x^2$.", markdown: null, action: null });
  });

  it("keeps escaped brackets from the selection as text", () => {
    const markdown = String.raw`See \[1\] and \[RFC 2119\] for details.`;
    expect(
      parseDocumentAssistantReply(
        `<replace_selection>\n${markdown}\n</replace_selection>`,
      ),
    ).toEqual({ reply: "", markdown, action: "replace" });
  });

  it("formats a reply back into the tagged form for later turns", () => {
    const reply = {
      reply: "Here it is.",
      markdown: "$$\nx\n$$",
      action: "replace" as const,
    };
    expect(formatDocumentAssistantReply(reply)).toBe(
      "Here it is.\n\n<replace_selection>\n$$\nx\n$$\n</replace_selection>",
    );
    expect(
      parseDocumentAssistantReply(formatDocumentAssistantReply(reply)),
    ).toEqual(reply);
    expect(
      formatDocumentAssistantReply({
        reply: "Only text",
        markdown: null,
        action: null,
      }),
    ).toBe("Only text");
  });
});
