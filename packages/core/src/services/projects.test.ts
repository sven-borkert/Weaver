import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@weaver/db/client";
import type { Capability, UserSecurityContext } from "../security/context";
import { createProject, listProjectsForUser } from "./projects";

function restrictedActor(): UserSecurityContext {
  return Object.freeze({
    kind: "user",
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
  it("bounds public listings without truncating internal authorization enumeration", async () => {
    const records = Array.from({ length: 1005 }, (_, i) => ({
      id: String(i),
      organization: { members: [{ role: "viewer" }] },
    }));
    const findMany = vi.fn(async (args: { take?: number }) =>
      records.slice(0, args.take),
    );
    const db = { project: { findMany } } as unknown as PrismaClient;
    const actor = {
      ...restrictedActor(),
      capabilities: new Set<Capability>(["content:read"]),
      allowedProjectIds: "all-accessible" as const,
    };
    expect(await listProjectsForUser(db, actor, { limit: 1000 })).toHaveLength(
      1000,
    );
    expect(await listProjectsForUser(db, actor)).toHaveLength(1005);
  });
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
