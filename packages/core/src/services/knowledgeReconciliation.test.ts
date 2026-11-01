import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FakeJobQueue,
  setJobQueueForTests,
  type JobQueue,
} from "../jobs/queue";
import { safelyRequestIndex } from "./knowledgeReconciliation";
import { enqueueKnowledgeReconciliation } from "./adminKnowledgeReconciliation";
import { createApiKeySecurityContext } from "../security/context";

const projectId = "11111111-1111-4111-8111-111111111111";
const enrichment = {
  projectId,
  generationId: "22222222-2222-4222-8222-222222222222",
  documentId: "33333333-3333-4333-8333-333333333333",
  sourceCommitSha: "a".repeat(40),
  pathAtSha: "document.md",
  configFingerprint: "b".repeat(64),
};

beforeEach(() => {
  vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
});

afterEach(() => {
  setJobQueueForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("safe knowledge enqueues", () => {
  it("reports a successful enqueue as accepted", async () => {
    setJobQueueForTests(new FakeJobQueue());

    await expect(
      safelyRequestIndex("project.reconcile", { projectId }),
    ).resolves.toBe(true);
  });

  it("reports a singleton-suppressed enqueue as not accepted", async () => {
    setJobQueueForTests(new FakeJobQueue());

    await expect(
      safelyRequestIndex("document.ai-enrich", enrichment),
    ).resolves.toBe(true);
    await expect(
      safelyRequestIndex("document.ai-enrich", enrichment),
    ).resolves.toBe(false);
  });

  it("deduplicates repeated content deletion deliveries", async () => {
    setJobQueueForTests(new FakeJobQueue());
    const payload = {
      projectId,
      sourceType: "document" as const,
      sourceId: enrichment.documentId,
      sourceCommitSha: enrichment.sourceCommitSha,
    };
    expect(await safelyRequestIndex("content.delete", payload)).toBe(true);
    expect(await safelyRequestIndex("content.delete", payload)).toBe(false);
  });

  it("reports a failed enqueue as not accepted", async () => {
    const queue: JobQueue = {
      send: vi.fn().mockRejectedValue(new Error("queue unavailable")),
      work: vi.fn(),
      schedule: vi.fn(),
      stop: vi.fn(),
    };
    setJobQueueForTests(queue);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      safelyRequestIndex("project.reconcile", { projectId }),
    ).resolves.toBe(false);
  });
});

describe("admin knowledge reconciliation", () => {
  const denied = createApiKeySecurityContext({
    userId: "user",
    globalRole: "Admin",
    keyId: "key",
    permissions: { content: ["write"] },
    projectIds: [],
  });
  const admin = createApiKeySecurityContext({
    userId: "admin",
    globalRole: "Admin",
    keyId: "admin-key",
    permissions: { system: ["admin"] },
    projectIds: [],
  });

  it("authorizes global reconciliation inside the service", async () => {
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    await expect(
      enqueueKnowledgeReconciliation({} as never, {}, denied),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(queue.jobs).toEqual([]);
  });

  it("reports a disabled global queue as not enqueued", async () => {
    vi.stubEnv("WEAVER_JOBS_ENABLED", "false");
    setJobQueueForTests(new FakeJobQueue());
    await expect(
      enqueueKnowledgeReconciliation({} as never, {}, admin),
    ).resolves.toEqual({ enqueued: false, job: "system.reconcile" });
  });
});
