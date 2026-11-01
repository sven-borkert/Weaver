import { describe, expect, it } from "vitest";
import { claimMcpAudit, type McpAuditState } from "./server";

describe("MCP audit arbitration", () => {
  it("allows exactly one synchronous claimant across callback and fallback paths", async () => {
    const state: McpAuditState = { claimed: false };

    const claims = await Promise.all([
      Promise.resolve().then(() => claimMcpAudit(state)),
      Promise.resolve().then(() => claimMcpAudit(state)),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(state.claimed).toBe(true);
  });
});
