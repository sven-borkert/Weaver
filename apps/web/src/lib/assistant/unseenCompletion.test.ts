import { describe, expect, it } from "vitest";
import { shouldMarkUnseen } from "./unseenCompletion";

const conversationId = "11111111-1111-4111-8111-111111111111";
const otherConversationId = "22222222-2222-4222-8222-222222222222";

describe("shouldMarkUnseen", () => {
  it("marks unseen when the panel is closed", () => {
    expect(
      shouldMarkUnseen({
        open: false,
        activeConversationId: null,
        conversationId,
      }),
    ).toBe(true);
  });

  it("does not mark unseen when the panel is open on the same conversation", () => {
    expect(
      shouldMarkUnseen({
        open: true,
        activeConversationId: conversationId,
        conversationId,
      }),
    ).toBe(false);
  });

  it("marks unseen when the panel is open on a different conversation", () => {
    expect(
      shouldMarkUnseen({
        open: true,
        activeConversationId: otherConversationId,
        conversationId,
      }),
    ).toBe(true);
  });

  it("marks unseen when the panel is open with no active conversation", () => {
    expect(
      shouldMarkUnseen({
        open: true,
        activeConversationId: null,
        conversationId,
      }),
    ).toBe(true);
  });
});
