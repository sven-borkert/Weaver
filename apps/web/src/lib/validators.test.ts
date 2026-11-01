import { describe, expect, it } from "vitest";

import { isUuid } from "./validators";

describe("isUuid", () => {
  it("accepts a valid UUID", () => {
    expect(isUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
  });

  it("rejects empty and too-short strings", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid("123")).toBe(false);
  });

  it("rejects 36-char strings with non-hex characters", () => {
    expect(isUuid("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")).toBe(false);
  });
});
