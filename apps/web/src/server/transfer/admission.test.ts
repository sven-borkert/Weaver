import { expect, it, vi } from "vitest";
vi.mock("~/env", () => ({ env: { WEAVER_MCP_RATE_LIMIT_PER_MINUTE: 600 } }));
import { createTransferSlots } from "./admission";

it("bounds each user's active bodies and releases a slot only once", () => {
  const acquire = createTransferSlots();
  const first = acquire("user");
  const second = acquire("user");
  expect(() => acquire("user")).toThrow("Too many concurrent transfers");
  first();
  first();
  const replacement = acquire("user");
  expect(() => acquire("user")).toThrow("Too many concurrent transfers");
  second();
  replacement();
  expect(() => acquire("user")).not.toThrow();
});

it("bounds total active transfer bodies across distinct users", () => {
  const acquire = createTransferSlots();
  const releases = Array.from({ length: 8 }, (_, i) => acquire(String(i)));
  expect(() => acquire("ninth")).toThrow("Too many concurrent transfers");
  releases[0]!();
  expect(() => acquire("ninth")).not.toThrow();
});
