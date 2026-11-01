import { describe, expect, it } from "vitest";

import { generatePassword } from "./generatePassword";

describe("generatePassword", () => {
  it("produces a URL-safe password of the requested length", () => {
    const password = generatePassword(20);
    expect(password).toHaveLength(20);
    expect(password).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("never repeats", () => {
    const seen = new Set(
      Array.from({ length: 50 }, () => generatePassword(20)),
    );
    expect(seen.size).toBe(50);
  });

  it("refuses a length below the policy minimum", () => {
    expect(() => generatePassword(8)).toThrow();
  });
});
