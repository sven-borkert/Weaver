import { expect, it } from "vitest";
import {
  canStartConversationRun,
  createConversationRequestGuard,
} from "./conversationRequest";

it("ignores out-of-order creates and creates completed after a user selects another conversation", () => {
  const guard = createConversationRequestGuard();
  const first = guard.begin();
  const second = guard.begin();
  expect(guard.isCurrent(first)).toBe(false);
  expect(guard.isCurrent(second)).toBe(true);
  guard.invalidate();
  expect(guard.isCurrent(second)).toBe(false);
});
it("does not let a late send in A replace B's live run", () => {
  expect(canStartConversationRun("b", "a")).toBe(false);
  expect(canStartConversationRun(null, "a")).toBe(false);
  expect(canStartConversationRun("a", "a")).toBe(true);
});
