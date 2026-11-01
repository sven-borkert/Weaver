import { describe, expect, it } from "vitest";

import { externalUrlSchema } from "./external-url";

describe("externalUrlSchema", () => {
  it("reports malformed input as a validation failure", () => {
    expect(() => externalUrlSchema.safeParse("not-a-url")).not.toThrow();
    expect(externalUrlSchema.safeParse("not-a-url").success).toBe(false);
  });

  it("accepts only HTTP and HTTPS URLs", () => {
    expect(externalUrlSchema.safeParse("http://example.com").success).toBe(
      true,
    );
    expect(externalUrlSchema.safeParse("https://example.com").success).toBe(
      true,
    );
    expect(externalUrlSchema.safeParse("ftp://example.com").success).toBe(
      false,
    );
  });
});
