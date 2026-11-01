import { describe, expect, it } from "vitest";
import { requiresApproval } from "./policy";

describe("external tool approval", () => {
  it("asks the assistant before writes unless the conversation auto-approves", () => {
    expect(requiresApproval("assistant", "read", false)).toBe(false);
    expect(requiresApproval("assistant", "write", false)).toBe(true);
    expect(requiresApproval("assistant", "read", true)).toBe(false);
    expect(requiresApproval("assistant", "write", true)).toBe(false);
  });
  it("never asks for MCP clients or tasks", () => {
    for (const owner of ["mcp", "task"] as const)
      expect(requiresApproval(owner, "write", false)).toBe(false);
  });
});
