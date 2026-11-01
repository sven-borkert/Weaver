import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generatePkce, randomState } from "./pkce";

describe("pkce", () => {
  it("produces an S256 challenge of a 43–128 char verifier", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(challenge).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
  });
  it("makes unpredictable states", () => {
    const a = randomState();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomState()).not.toBe(a);
  });
});
