import { describe, expect, it } from "vitest";
import {
  humanAssistantError,
  isConversationUnavailable,
  renameTitleFieldError,
} from "./conversationErrors";

describe("humanAssistantError", () => {
  it("replaces a raw CoreError code with the fallback", () => {
    expect(humanAssistantError("NOT_FOUND", "Couldn't do that")).toBe(
      "Couldn't do that",
    );
    expect(humanAssistantError("FORBIDDEN", "Couldn't do that")).toBe(
      "Couldn't do that",
    );
  });

  it("replaces the codes the send/cancel/accept paths surface", () => {
    // Composer's sendMessage/cancelRun in a deleted conversation, and
    // acceptProposal's stale-precondition path.
    expect(humanAssistantError("PRECONDITION_FAILED", "fallback")).toBe(
      "fallback",
    );
    expect(humanAssistantError("INTERNAL_SERVER_ERROR", "fallback")).toBe(
      "fallback",
    );
  });

  it("falls back when there is no message at all", () => {
    expect(humanAssistantError(undefined, "fallback")).toBe("fallback");
    expect(humanAssistantError("", "fallback")).toBe("fallback");
    expect(humanAssistantError("   ", "fallback")).toBe("fallback");
  });

  it("passes through a real service message untouched", () => {
    expect(
      humanAssistantError("a run is still active; cancel it first", "fallback"),
    ).toBe("a run is still active; cancel it first");
  });
});

describe("isConversationUnavailable", () => {
  it("recognises the three codes that mean the conversation is not ours", () => {
    for (const code of ["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"]) {
      expect(isConversationUnavailable({ data: { code } })).toBe(true);
    }
  });

  it("leaves transient failures alone so they are retried, not cleared", () => {
    expect(isConversationUnavailable({ data: { code: "TIMEOUT" } })).toBe(
      false,
    );
    expect(
      isConversationUnavailable({ data: { code: "INTERNAL_SERVER_ERROR" } }),
    ).toBe(false);
    expect(isConversationUnavailable(null)).toBe(false);
    expect(isConversationUnavailable(undefined)).toBe(false);
    expect(isConversationUnavailable(new Error("boom"))).toBe(false);
  });
});

describe("renameTitleFieldError", () => {
  it("reports the limit for the service's field-pinned BAD_REQUEST", () => {
    expect(renameTitleFieldError({ data: { field: "title" } })).toBe(
      "Titles are limited to 200 characters.",
    );
  });

  it("reports the same limit when the transport's Zod cap rejects first", () => {
    expect(
      renameTitleFieldError({
        data: {
          zodError: {
            fieldErrors: {
              title: ["String must contain at most 400 character(s)"],
            },
          },
        },
      }),
    ).toBe("Titles are limited to 200 characters.");
  });

  it("returns null for an unrelated error", () => {
    expect(renameTitleFieldError({ data: { field: "conversationId" } })).toBe(
      null,
    );
    expect(renameTitleFieldError({})).toBe(null);
    expect(
      renameTitleFieldError({ data: { zodError: { fieldErrors: {} } } }),
    ).toBe(null);
  });
});
