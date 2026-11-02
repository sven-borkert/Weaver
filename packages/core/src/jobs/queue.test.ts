import { ASSISTANT_RUN_TIMEOUT_MS } from "../assistant/limits";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  FakeJobQueue,
  requestKnowledgeJob,
  setJobQueueForTests,
  setProcessJobQueue,
  setProcessJobsStopped,
  type JobQueue,
} from "./queue";
import type { PgBossQueue } from "./pgBossQueue";
import { knowledgeSystemContextForTests } from "./systemContext";
import {
  KNOWLEDGE_ENRICHMENT_DEADLINE_MS,
  INGESTION_PARSE_EXPIRE_IN_SECONDS,
  knowledgeJobExpireInSeconds,
  knowledgeJobWorkerConcurrency,
  type KnowledgeJobName,
  type KnowledgeJobPayloads,
} from "./types";
import { MAX_REQUEST_TIMEOUT_MS } from "../services/llmConnections";

const originalJobsEnabled = process.env.WEAVER_JOBS_ENABLED;

afterEach(() => {
  vi.unstubAllEnvs();
  setJobQueueForTests(null);
  if (originalJobsEnabled === undefined) {
    delete process.env.WEAVER_JOBS_ENABLED;
  } else {
    process.env.WEAVER_JOBS_ENABLED = originalJobsEnabled;
  }
});

describe("knowledge queue", () => {
  it("ends enrichment before its lease even when a call starts at the deadline", () => {
    // Paced requests make the call count unbounded, so the deadline bounds the job instead.
    expect(MAX_REQUEST_TIMEOUT_MS).toBe(120_000);
    expect(
      knowledgeJobExpireInSeconds("document.ai-enrich"),
    ).toBeLessThanOrEqual(24 * 60 * 60);
    expect(
      KNOWLEDGE_ENRICHMENT_DEADLINE_MS + MAX_REQUEST_TIMEOUT_MS,
    ).toBeLessThan(knowledgeJobExpireInSeconds("document.ai-enrich") * 1_000);
    expect(knowledgeJobExpireInSeconds("document.search-sync")).toBe(15 * 60);
    expect(knowledgeJobExpireInSeconds("wiki.run")).toBeGreaterThanOrEqual(
      125 * 60,
    );
    expect(knowledgeJobWorkerConcurrency("wiki.run", 2)).toBe(1);
  });

  it("keeps an assistant job alive past the run's own timeout", () => {
    expect(
      knowledgeJobExpireInSeconds("assistant.run") * 1_000,
    ).toBeGreaterThan(ASSISTANT_RUN_TIMEOUT_MS);
  });

  it("gives system reconciliation time to cover large installations", () => {
    expect(knowledgeJobExpireInSeconds("system.reconcile")).toBe(60 * 60);
  });

  it("leases ingestion.parse for longer than an ordinary knowledge job", () => {
    // The OCR budget outlives the 15-minute default; without this pg-boss
    // redelivers a scan that is still making paid vision calls.
    expect(knowledgeJobExpireInSeconds("ingestion.parse")).toBeGreaterThan(
      knowledgeJobExpireInSeconds("document.search-sync"),
    );
    expect(knowledgeJobExpireInSeconds("ingestion.parse")).toBe(
      INGESTION_PARSE_EXPIRE_IN_SECONDS,
    );
  });

  it("keeps provider fanout at one regardless of general worker concurrency", () => {
    expect(knowledgeJobWorkerConcurrency("document.ai-enrich", 8)).toBe(1);
    expect(knowledgeJobWorkerConcurrency("document.search-sync", 8)).toBe(8);
  });

  it("only permits scheduling the payload-free maintenance jobs", () => {
    expectTypeOf<Parameters<PgBossQueue["schedule"]>[0]>().toEqualTypeOf<
      | "system.reconcile"
      | "assistant.reconcile"
      | "task.tick"
      | "exam.tick"
      | "wiki.tick"
      | "project.git-sync"
    >();
  });

  it("captures typed identifier-only jobs", async () => {
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    const data = {
      projectId: "11111111-1111-4111-8111-111111111111",
      documentId: "22222222-2222-4222-8222-222222222222",
      sourceCommitSha: "a".repeat(40),
      pathAtSha: "runbook.md",
    };

    await requestKnowledgeJob("document.search-sync", data);

    expect(queue.jobs).toEqual([{ name: "document.search-sync", data }]);
  });

  it("deduplicates one queued enrichment target regardless of path", async () => {
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    const data = {
      projectId: "11111111-1111-4111-8111-111111111111",
      generationId: "22222222-2222-4222-8222-222222222222",
      documentId: "33333333-3333-4333-8333-333333333333",
      sourceCommitSha: "a".repeat(40),
      pathAtSha: "first-path.md",
      configFingerprint: "b".repeat(64),
    };

    const first = await requestKnowledgeJob("document.ai-enrich", data);
    const duplicate = await requestKnowledgeJob("document.ai-enrich", {
      ...data,
      pathAtSha: "renamed-path.md",
    });

    expect(first).not.toBeNull();
    expect(duplicate).toBeNull();
    expect(queue.jobs).toEqual([{ name: "document.ai-enrich", data }]);
  });

  it("ingestion review: only one queued delivery per stage and attempt survives backlog recovery", async () => {
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    const payload = {
      projectId: "11111111-1111-4111-8111-111111111111",
      fileId: "22222222-2222-4222-8222-222222222222",
      contentDigest: "a".repeat(64),
      baseAttemptCount: 0,
    };
    expect(
      await requestKnowledgeJob("ingestion.parse", payload),
    ).not.toBeNull();
    expect(await requestKnowledgeJob("ingestion.parse", payload)).toBeNull();
    expect(
      await requestKnowledgeJob("ingestion.analyze", payload),
    ).not.toBeNull();
    expect(
      await requestKnowledgeJob("ingestion.parse", {
        ...payload,
        baseAttemptCount: 1,
      }),
    ).not.toBeNull();
    expect(queue.jobs).toHaveLength(3);
  });

  it("does not enqueue when knowledge jobs are disabled", async () => {
    process.env.WEAVER_JOBS_ENABLED = "false";
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);

    await expect(
      requestKnowledgeJob("project.reconcile", {
        projectId: "11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toBeNull();
    expect(queue.jobs).toEqual([]);
  });

  it("routes through a registered process queue instead of the lazy publisher", async () => {
    const queue = new FakeJobQueue();
    setProcessJobQueue(queue);
    try {
      await requestKnowledgeJob("system.reconcile", {});
      expect(queue.jobs).toEqual([{ name: "system.reconcile", data: {} }]);
    } finally {
      setProcessJobQueue(null);
    }
  });

  it("rejects the publisher fallback once the process job runtime stopped", async () => {
    vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
    setProcessJobsStopped(true);
    try {
      await expect(requestKnowledgeJob("system.reconcile", {})).rejects.toThrow(
        "after the worker runtime stopped",
      );
    } finally {
      setProcessJobsStopped(false);
    }
  });

  it("rethrows enqueue errors", async () => {
    const error = new Error("queue unavailable");
    const queue: JobQueue = {
      async send<N extends KnowledgeJobName>(
        _name: N,
        _data: KnowledgeJobPayloads[N],
      ) {
        throw error;
      },
      work: () => Promise.resolve(),
      schedule: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    };
    setJobQueueForTests(queue);

    await expect(requestKnowledgeJob("system.reconcile", {})).rejects.toBe(
      error,
    );
  });
});

describe("FakeJobQueue handlers", () => {
  it("captures registered handlers and runs them on demand", async () => {
    const queue = new FakeJobQueue();
    const seen: unknown[] = [];
    await queue.work("project.reconcile", async (data, execution) => {
      seen.push({
        data,
        jobId: execution.jobId,
        retryCount: execution.retryCount,
      });
    });
    await queue.run("project.reconcile", { projectId: "p1" });
    expect(seen).toEqual([
      { data: { projectId: "p1" }, jobId: "fake-run-1", retryCount: 0 },
    ]);
    await expect(queue.run("system.reconcile", {})).rejects.toThrow(
      /no handler/,
    );
  });

  it("preserves an explicitly unknown retry count", async () => {
    const queue = new FakeJobQueue();
    let retryCount: number | null | undefined;
    await queue.work("project.reconcile", async (_data, execution) => {
      retryCount = execution.retryCount;
    });

    await queue.run(
      "project.reconcile",
      { projectId: "p1" },
      { retryCount: null },
    );

    expect(retryCount).toBeNull();
  });
});

describe("knowledge system context", () => {
  it("refuses to mint a test context outside the test runtime", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(() => knowledgeSystemContextForTests()).toThrow(
      "KnowledgeSystemContext is only available to tests in the test runtime",
    );
  });
});
