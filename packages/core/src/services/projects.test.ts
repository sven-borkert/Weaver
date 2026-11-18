import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@weaver/db/client";
import type { Capability, UserSecurityContext } from "../security/context";
import {
  createProject,
  listProjectsForUser,
  softDeleteProject,
} from "./projects";

vi.mock("./projectRepo", () => ({
  withProjectRepo: async (_projectId: string, run: () => Promise<unknown>) =>
    run(),
}));

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

describe("softDeleteProject", () => {
  it("rechecks personal workspace protection at deletion", async () => {
    const actor = {
      ...restrictedActor(),
      allowedProjectIds: "all-accessible" as const,
    };
    const project = { organization: { members: [{ role: "owner" }] } };
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({ ...project, personalOwnerId: null })
      .mockResolvedValue({ ...project, personalOwnerId: actor.userId });
    const update = vi.fn();
    const updateMany = vi.fn();
    const session = { project: { findFirst, update, updateMany } };
    const db = {
      ...session,
      $transaction: (run: (tx: typeof session) => unknown) => run(session),
    } as unknown as PrismaClient;
    await expect(softDeleteProject(db, "p1", actor)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Personal workspaces cannot be deleted",
    });
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
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
