import { describe, expect, it } from "vitest";
import { createTaskSecurityContext, hasCapability } from "./context";

describe("createTaskSecurityContext", () => {
  it("acts for the owner with read and write only, even for an Admin", () => {
    const ctx = createTaskSecurityContext({
      userId: "u1",
      globalRole: "Admin",
      runId: "r1",
    });
    expect(ctx.authenticationMethod).toBe("task");
    expect(ctx.credentialId).toBe("task-run:r1");
    expect(ctx.allowedProjectIds).toBe("all-accessible");
    expect([...ctx.capabilities].sort()).toEqual([
      "content:read",
      "content:write",
    ]);
    expect(hasCapability(ctx, "system:admin")).toBe(false);
    expect(hasCapability(ctx, "assistant:use")).toBe(false);
    expect(Object.isFrozen(ctx)).toBe(true);
  });
});
