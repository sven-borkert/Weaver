import type { PrismaClient } from "@weaver/db/client";
import type { SecurityContext } from "../security/context";
import { describe, expect, it, vi } from "vitest";
import { CoreError } from "../errors";
import {
  resolveMcpScopeSnapshot,
  assertInScope,
  MAX_SCOPE_PROJECTS,
  scopeRequestSchema,
  scopeSnapshotSchema,
  type ScopeSnapshot,
} from "./scope";

const snapshot: ScopeSnapshot = {
  kind: "projects",
  projectIds: ["11111111-1111-4111-8111-111111111111"],
  documentId: null,
  tableId: null,
  resolvedAt: "2026-09-02T00:00:00.000Z",
  truncated: false,
};

describe("scope schemas", () => {
  it("accepts every request kind and rejects unknown kinds", () => {
    expect(scopeRequestSchema.parse({ kind: "all" })).toEqual({ kind: "all" });
    expect(
      scopeRequestSchema.parse({
        kind: "document",
        projectId: snapshot.projectIds[0],
        documentId: snapshot.projectIds[0],
      }).kind,
    ).toBe("document");
    expect(() => scopeRequestSchema.parse({ kind: "everything" })).toThrow();
    expect(scopeSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("defaults truncated for snapshots stored before the flag existed", () => {
    const { truncated: _omitted, ...legacy } = snapshot;
    expect(scopeSnapshotSchema.parse(legacy)).toEqual({
      ...legacy,
      truncated: false,
    });
  });

  it("rejects a project list over the cap, so a snapshot can never be stored unleasable", () => {
    const ids = Array.from(
      { length: MAX_SCOPE_PROJECTS + 1 },
      (_unused, i) => `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
    );
    expect(
      scopeSnapshotSchema.safeParse({ ...snapshot, projectIds: ids }).success,
    ).toBe(false);
  });
});

describe("assertInScope", () => {
  it("passes for in-scope projects and throws SCOPE_VIOLATION otherwise", () => {
    expect(() =>
      assertInScope(snapshot, snapshot.projectIds[0]!),
    ).not.toThrow();
    try {
      assertInScope(snapshot, "22222222-2222-4222-8222-222222222222");
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).code).toBe("FORBIDDEN");
      expect((error as CoreError).details).toEqual({
        reason: "SCOPE_VIOLATION",
      });
    }
  });
});

it("bounds MCP membership reads at the database with a stable order", async () => {
  const findMany = vi.fn().mockResolvedValue([]);
  await resolveMcpScopeSnapshot(
    { project: { findMany } } as unknown as PrismaClient,
    { userId: "user", allowedProjectIds: "all-accessible" } as SecurityContext,
  );
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      take: MAX_SCOPE_PROJECTS + 1,
      select: { id: true },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    }),
  );
});
