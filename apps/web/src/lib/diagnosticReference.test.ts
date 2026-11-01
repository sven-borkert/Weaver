import { describe, expect, it } from "vitest";
import { splitReference } from "./diagnosticReference";

describe("splitReference", () => {
  it("separates a trailing reference from the message", () => {
    expect(
      splitReference(
        "Could not reach the LLM provider: connection refused [ECONNREFUSED] (ref a3f9c2e1)",
      ),
    ).toEqual({
      text: "Could not reach the LLM provider: connection refused [ECONNREFUSED]",
      reference: "a3f9c2e1",
    });
    expect(splitReference("plain failure")).toEqual({
      text: "plain failure",
      reference: null,
    });
    expect(splitReference(null)).toEqual({ text: "", reference: null });
  });
});
