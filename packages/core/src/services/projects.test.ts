import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@weaver/db/client";
import type { Capability, SecurityContext } from "../security/context";
import { createProject, listProjectsForUser } from "./projects";

function restrictedActor(): SecurityContext {
  return Object.freeze({
    userId: "11111111-1111-4111-8111-111111111111",
    globalRole: "User",
    authenticationMethod: "apiKey",
    credentialId: "key-1",
    capabilities: new Set<Capability>(["content:write"]),
    allowedProjectIds: new Set(["p1"]),
  });
}

describe("createProject", () => {
  it("rejects a restricted credential before touching the database", async () => {
    // db is never called: the restriction check throws first.
    const db = {} as PrismaClient;
    await expect(
      createProject(db, restrictedActor(), { name: "New Project" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("listProjectsForUser", () => {
  it("rejects a credential without content:read before touching the database", async () => {
    const actor = Object.freeze({
      ...restrictedActor(),
      capabilities: new Set<Capability>(["mcp:use"]),
      allowedProjectIds: "all-accessible" as const,
    });

    await expect(
      listProjectsForUser({} as PrismaClient, actor),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
