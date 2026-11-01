import { expect, it } from "vitest";
import type { PrismaClient } from "@weaver/db/client";
import { createSessionSecurityContext } from "../security/context";
import { getDiagnosticEvent } from "./diagnosticEvents";

const projectA = "10000000-0000-4000-8000-000000000001";
const projectB = "10000000-0000-4000-8000-000000000002";
const actor = createSessionSecurityContext({
  userId: "10000000-0000-4000-8000-000000000003",
  globalRole: "Admin",
  sessionId: "session",
});

function fixture(bodyProjectIds: unknown, memberships = [projectB]) {
  return {
    diagnosticEvent: {
      findUnique: async () => ({
        id: "10000000-0000-4000-8000-000000000004",
        runId: "10000000-0000-4000-8000-000000000005",
        projectId: projectB,
        runtime: "worker",
        bodyProjectIds,
        requestBody: "PRIVATE PROJECT A REQUEST",
        responseBody: "PRIVATE PROJECT A RESPONSE",
      }),
    },
    assistantRun: {
      findUnique: async () => ({
        scopeSnapshot: {
          kind: "project",
          projectIds: [projectB],
          documentId: null,
          tableId: null,
          resolvedAt: new Date().toISOString(),
          truncated: false,
        },
      }),
    },
    project: {
      findFirst: async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        organization: {
          members: memberships.includes(where.id) ? [{ role: "viewer" }] : [],
        },
      }),
    },
  } as unknown as PrismaClient;
}

it.each(["request", "response"] as const)(
  "requires all captured projects for the %s body after a scope change",
  async (body) => {
    const db = fixture([projectA, projectB]);
    await expect(
      getDiagnosticEvent(db, actor, { id: "event", body }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      getDiagnosticEvent(
        fixture([projectA, projectB], [projectA, projectB]),
        actor,
        {
          id: "event",
          body,
        },
      ),
    ).resolves.toMatchObject({
      body: { text: `PRIVATE PROJECT A ${body.toUpperCase()}` },
    });
  },
);

it.each([undefined, null, ["invalid"], { projectIds: [projectB] }])(
  "fails closed for legacy or malformed run body provenance %j",
  async (bodyProjectIds) => {
    const db = fixture(bodyProjectIds);
    await expect(
      getDiagnosticEvent(db, actor, { id: "event", body: "request" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      getDiagnosticEvent(db, actor, { id: "event" }),
    ).resolves.toMatchObject({
      body: null,
    });
  },
);
