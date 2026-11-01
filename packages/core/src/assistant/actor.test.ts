import { describe, expect, it } from "vitest";
import {
  createApiKeySecurityContext,
  createSessionSecurityContext,
} from "../security/context";
import { deserializeSecurityContext, serializeSecurityContext } from "./actor";

describe("actor snapshots", () => {
  it("round-trips a session context", () => {
    const ctx = createSessionSecurityContext({
      userId: "u",
      globalRole: "Admin",
      sessionId: "s",
    });
    const back = deserializeSecurityContext(serializeSecurityContext(ctx));
    expect(back.userId).toBe("u");
    expect(back.authenticationMethod).toBe("session");
    expect([...back.capabilities].sort()).toEqual([...ctx.capabilities].sort());
    expect(back.allowedProjectIds).toBe("all-accessible");
    expect(Object.isFrozen(back)).toBe(true);
  });
  it("round-trips a project-restricted key context", () => {
    const ctx = createApiKeySecurityContext({
      userId: "u",
      globalRole: "User",
      keyId: "k",
      permissions: null,
      projectIds: ["p1"],
    });
    const back = deserializeSecurityContext(serializeSecurityContext(ctx));
    expect(back.allowedProjectIds).toEqual(new Set(["p1"]));
  });
});
