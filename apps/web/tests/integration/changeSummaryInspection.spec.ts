import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "@weaver/assistant-tools/contract";
import { listDocumentChangeSummariesTool } from "@weaver/assistant-tools/tools/admin/diagnostics";
import { listDocumentChangeSummaries } from "@weaver/core/services/documentChangeSummaryInspection";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

const sha = (value: number) => value.toString(16).padStart(40, "0");

async function seed() {
  const admin = await makeUser("Admin", "summary-inspect-admin");
  const member = await makeUser("User", "summary-inspect-member");
  const alpha = await makeProject("Alpha summaries");
  const beta = await makeProject("Beta summaries");
  await addMembership(alpha.id, member.id, "Owner");
  const documentId = "11111111-1111-4111-8111-111111111111";
  const base = Date.UTC(2026, 8, 16, 12, 0, 0);
  await getPrisma().documentChangeSummary.createMany({
    data: [
      {
        projectId: alpha.id,
        commitSha: sha(1),
        documentId,
        pathAtSha: "secret-path.md",
        basePathAtSha: "secret-base.md",
        baseCommitSha: sha(100),
        status: "ready",
        summary: "Secret summary sentinel",
        attempts: 1,
        lastJobId: "job-1",
        createdAt: new Date(base),
        updatedAt: new Date(base + 5_000),
        completedAt: new Date(base + 5_000),
      },
      {
        projectId: alpha.id,
        commitSha: sha(2),
        documentId,
        pathAtSha: "secret-path.md",
        baseCommitSha: sha(1),
        status: "failed",
        failureReason: "timeout",
        attempts: 3,
        lastErrorClass: "AiProviderError",
        lastJobId: "job-2",
        createdAt: new Date(base + 60_000),
        updatedAt: new Date(base + 120_000),
        completedAt: new Date(base + 120_000),
      },
      {
        projectId: beta.id,
        commitSha: sha(3),
        documentId: "22222222-2222-4222-8222-222222222222",
        pathAtSha: "other.md",
        baseCommitSha: sha(200),
        status: "pending",
        attempts: 0,
        createdAt: new Date(base + 120_000),
        updatedAt: new Date(base + 120_000),
      },
    ],
  });
  return { admin, member, alpha, beta, documentId };
}

describe("document change summary inspection", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("lists metadata newest first with counts and project facets, never content", async () => {
    const { admin, alpha, beta } = await seed();
    const page = await listDocumentChangeSummaries(
      getPrisma(),
      securityContextFor(admin),
      {},
    );
    expect(page.items.map((item) => item.commitSha)).toEqual([
      sha(3),
      sha(2),
      sha(1),
    ]);
    expect(page.items[1]).toMatchObject({
      projectId: alpha.id,
      projectName: "Alpha summaries",
      status: "failed",
      failureReason: "timeout",
      attempts: 3,
      lastErrorClass: "AiProviderError",
      lastJobId: "job-2",
      completedAt: new Date(Date.UTC(2026, 8, 16, 12, 2, 0)),
    });
    expect(page.counts).toEqual({
      pending: 1,
      ready: 1,
      failed: 1,
      skipped: 0,
    });
    expect(page.projects).toEqual([
      { id: alpha.id, name: "Alpha summaries" },
      { id: beta.id, name: "Beta summaries" },
    ]);
    expect(page).toMatchObject({ nextCursor: null, truncated: false });
    expect(JSON.stringify(page)).not.toMatch(
      /Secret summary sentinel|secret-path|secret-base|other\.md/,
    );
  });

  it("filters, counts without the status filter, and pages with a cursor", async () => {
    const { admin, beta, documentId } = await seed();
    const db = getPrisma();
    const actor = securityContextFor(admin);

    const failed = await listDocumentChangeSummaries(db, actor, {
      status: "failed",
    });
    expect(failed.items.map((item) => item.commitSha)).toEqual([sha(2)]);
    expect(failed.counts).toEqual({
      pending: 1,
      ready: 1,
      failed: 1,
      skipped: 0,
    });

    const inBeta = await listDocumentChangeSummaries(db, actor, {
      projectId: beta.id,
    });
    expect(inBeta.items.map((item) => item.commitSha)).toEqual([sha(3)]);
    expect(inBeta.counts).toEqual({
      pending: 1,
      ready: 0,
      failed: 0,
      skipped: 0,
    });

    const forDocument = await listDocumentChangeSummaries(db, actor, {
      documentId,
      since: new Date(Date.UTC(2026, 8, 16, 12, 0, 30)),
    });
    expect(forDocument.items.map((item) => item.commitSha)).toEqual([sha(2)]);

    const first = await listDocumentChangeSummaries(db, actor, { limit: 1 });
    expect(first.items.map((item) => item.commitSha)).toEqual([sha(3)]);
    expect(first.truncated).toBe(true);
    const second = await listDocumentChangeSummaries(db, actor, {
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((item) => item.commitSha)).toEqual([sha(2)]);

    await expect(
      listDocumentChangeSummaries(db, actor, { cursor: "not-a-cursor" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("is admin-only and exposed through tRPC and MCP", async () => {
    const { admin, member } = await seed();
    await expect(
      listDocumentChangeSummaries(getPrisma(), securityContextFor(member), {}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(member).diagnostics.listChangeSummaries({}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const viaTrpc = await callerFor(admin).diagnostics.listChangeSummaries({
      status: "pending",
    });
    expect(viaTrpc.items.map((item) => item.commitSha)).toEqual([sha(3)]);

    const ctx: ToolContext = {
      db: getPrisma(),
      actor: securityContextFor(admin),
      scope: {
        kind: "all",
        projectIds: [],
        documentId: null,
        tableId: null,
        resolvedAt: new Date().toISOString(),
        truncated: false,
      },
      profile: { name: null, email: admin.email },
      run: null,
    };
    const viaTool = (
      await listDocumentChangeSummariesTool.execute({ limit: 2 }, ctx)
    ).output as {
      items: Array<{ commitSha: string }>;
      nextCursor: string | null;
    };
    expect(viaTool.items.map((item) => item.commitSha)).toEqual([
      sha(3),
      sha(2),
    ]);
    expect(viaTool.nextCursor).not.toBeNull();
    expect(JSON.stringify(viaTool)).not.toMatch(
      /Secret summary sentinel|secret-path/,
    );
  });
});
