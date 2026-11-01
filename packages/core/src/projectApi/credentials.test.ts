import { describe, expect, it } from "vitest";
import {
  generateProjectMachineToken,
  verifyProjectMachineDigest,
} from "./credentials";

const KEY_ID = "e4816359-a679-4c52-880a-944aa4744888";

describe("project machine secrets", () => {
  it("generates a project token with 256 bits of random secret", () => {
    const a = generateProjectMachineToken(KEY_ID);
    const b = generateProjectMachineToken(KEY_ID);
    expect(a.secret).toMatch(
      /^wvr_project_e4816359-a679-4c52-880a-944aa4744888\.[A-Za-z0-9_-]{43}$/,
    );
    expect(Buffer.from(a.secret.split(".")[1]!, "base64url")).toHaveLength(32);
    expect(a.secret).not.toBe(b.secret);
    expect(a.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(a.digest).not.toContain(a.secret);
  });

  it("accepts only the complete matching secret", () => {
    const token = generateProjectMachineToken(KEY_ID);
    expect(verifyProjectMachineDigest(token.secret, token.digest)).toBe(true);
    expect(verifyProjectMachineDigest(`${token.secret}x`, token.digest)).toBe(
      false,
    );
    expect(
      verifyProjectMachineDigest(token.secret.slice(1), token.digest),
    ).toBe(false);
    expect(verifyProjectMachineDigest(token.secret, "abcd")).toBe(false);
    expect(verifyProjectMachineDigest(token.secret, "z".repeat(64))).toBe(
      false,
    );
  });
});
