import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticEmitInput } from "../diagnostics/writer";

const diagnosticOperations = vi.hoisted(() => ({
  emitDiagnostic: vi.fn<(input: DiagnosticEmitInput) => void>(),
}));
vi.mock("../diagnostics/writer", () => diagnosticOperations);

import {
  activateCompletedGeneration,
  ensureGenerationForCurrentConfig,
  generationDocumentRecoveryDue,
  startGenerationBuild,
  type GenerationConfiguration,
} from "./knowledgeGenerations";

const configuration = {
  projectId: "11111111-1111-4111-8111-111111111111",
  configFingerprint: "a".repeat(64),
  embeddingModel: "embedding-model",
  embeddingDimensions: 1536,
  extractionSchemaVersion: 1,
  promptVersion: "prompt-v1",
  routeSnapshot: null,
} satisfies GenerationConfiguration;

const generation = {
  id: "22222222-2222-4222-8222-222222222222",
  projectId: configuration.projectId,
  configFingerprint: configuration.configFingerprint,
  embeddingModel: configuration.embeddingModel,
  embeddingDimensions: configuration.embeddingDimensions,
  extractionSchemaVersion: configuration.extractionSchemaVersion,
  promptVersion: configuration.promptVersion,
  routeSnapshot: null,
  status: "building" as const,
  documentTotal: 0,
  documentReadyCount: 0,
  documentFailedCount: 0,
  failureKind: null,
  failureSummary: null,
  createdAt: new Date("2026-09-04T00:00:00.000Z"),
  completedAt: null,
  activatedAt: null,
  supersededAt: null,
};

type RoutingChangeRecordFixture = {
  userId: string;
  indexFingerprint: string;
  at: string;
};

/** The fake's default (no active generation, no routing-change record) matches "nothing has ever built here". */
function snapshotTransaction(
  scenario: {
    activeGeneration?: { configFingerprint: string } | null;
    routingChangeRecord?: RoutingChangeRecordFixture | null;
    requesterDeleted?: boolean;
  } = {},
) {
  const activeGeneration = scenario.activeGeneration ?? null;
  const routingChangeRecord = scenario.routingChangeRecord ?? null;
  return {
    user: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(scenario.requesterDeleted ? null : { id: where.id }),
      ),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ deletedAt: null }]),
    knowledgeGeneration: {
      create: vi.fn().mockResolvedValue(generation),
      // Truthful default: a previous active generation only exists when the scenario says so.
      findFirst: vi.fn().mockResolvedValue(activeGeneration),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      updateManyAndReturn: vi.fn().mockResolvedValue([]),
    },
    systemSetting: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          routingChangeRecord ? { value: routingChangeRecord } : null,
        ),
    },
  };
}

beforeEach(() => {
  diagnosticOperations.emitDiagnostic.mockClear();
});

describe("knowledge delivery recovery", () => {
  const now = new Date("2026-09-22T12:00:00Z");
  const processing = {
    status: "processing" as const,
    failureKind: null,
    completedAt: null,
    lastAttemptAt: new Date("2026-09-22T11:59:00Z"),
    processingJobId: "44444444-4444-4444-8444-444444444444",
    processingRetryCount: 2,
  };

  it("allows the queue's newer retry to reclaim a recently interrupted delivery", () => {
    expect(
      generationDocumentRecoveryDue(processing, now, {
        jobId: processing.processingJobId,
        retryCount: 3,
      }),
    ).toBe(true);
  });

  it.each([
    { jobId: processing.processingJobId, retryCount: 2 },
    { jobId: processing.processingJobId, retryCount: 1 },
    { jobId: "55555555-5555-4555-8555-555555555555", retryCount: 3 },
    { jobId: processing.processingJobId, retryCount: null },
  ])(
    "retains ownership against duplicate or unrelated delivery %j",
    (delivery) => {
      expect(generationDocumentRecoveryDue(processing, now, delivery)).toBe(
        false,
      );
    },
  );
});

describe("knowledge generation diagnostics", () => {
  it("reports an incompatible shadow superseded by the current configuration", async () => {
    // The scenario's one active generation already matches the current config,
    // so it is both the findMany candidate and the (unreached) findFirst row.
    const tx = snapshotTransaction({
      activeGeneration: { configFingerprint: configuration.configFingerprint },
    });
    tx.knowledgeGeneration.findMany.mockResolvedValue([
      { ...generation, status: "active" },
    ]);
    tx.knowledgeGeneration.updateManyAndReturn.mockResolvedValue([
      { id: "33333333-3333-4333-8333-333333333333" },
    ]);
    const db = {
      $transaction: (operation: (client: never) => unknown) =>
        operation(tx as never),
    };
    await ensureGenerationForCurrentConfig(
      {} as never,
      db as never,
      configuration,
    );
    expect(diagnosticOperations.emitDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "knowledge.generation.superseded",
        generationId: "33333333-3333-4333-8333-333333333333",
        projectId: configuration.projectId,
      }),
    );
  });

  it("does not report a generation created when its caller transaction rolls back", async () => {
    const rollback = new Error("transaction rolled back");
    const tx = snapshotTransaction();
    const db = {
      $transaction: vi.fn(async (operation: (client: never) => unknown) => {
        await operation(tx as never);
        throw rollback;
      }),
    };

    await expect(
      startGenerationBuild({} as never, db as never, configuration),
    ).rejects.toBe(rollback);

    expect(diagnosticOperations.emitDiagnostic).not.toHaveBeenCalled();
  });

  it("reports a committed generation creation exactly once", async () => {
    const tx = snapshotTransaction();
    const db = {
      $transaction: vi
        .fn()
        .mockImplementationOnce((operation: (client: never) => unknown) =>
          operation(tx as never),
        )
        .mockResolvedValueOnce(null),
    };

    await ensureGenerationForCurrentConfig(
      {} as never,
      db as never,
      configuration,
    );

    expect(diagnosticOperations.emitDiagnostic).toHaveBeenCalledTimes(1);
    expect(diagnosticOperations.emitDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "knowledge.generation.created",
        projectId: configuration.projectId,
        generationId: generation.id,
      }),
    );
  });
});

describe("knowledge generation build attribution", () => {
  const userId = "66666666-6666-4666-8666-666666666666";

  /** Only the first `db.$transaction` call runs the real operation; the resumed build's own transaction resolves null so it exits without needing further fixture shape. */
  function dbForSingleAttempt(tx: ReturnType<typeof snapshotTransaction>) {
    return {
      $transaction: vi
        .fn()
        .mockImplementationOnce((operation: (client: never) => unknown) =>
          operation(tx as never),
        )
        .mockResolvedValueOnce(null),
    };
  }

  function createdData(tx: ReturnType<typeof snapshotTransaction>) {
    const create = tx.knowledgeGeneration.create as unknown as {
      mock: { calls: Array<[{ data: Record<string, unknown> }]> };
    };
    return create.mock.calls[0]![0].data;
  }

  it("attributes a first-ever build as initial", async () => {
    const tx = snapshotTransaction();

    await ensureGenerationForCurrentConfig(
      {} as never,
      dbForSingleAttempt(tx) as never,
      configuration,
    );

    expect(createdData(tx)).toMatchObject({
      buildTrigger: "initial",
      requestedById: null,
    });
  });

  it("attributes a rebuild with no matching routing-change record as an index upgrade", async () => {
    const tx = snapshotTransaction({
      activeGeneration: { configFingerprint: "previous-fingerprint" },
    });

    await ensureGenerationForCurrentConfig(
      {} as never,
      dbForSingleAttempt(tx) as never,
      configuration,
    );

    expect(createdData(tx)).toMatchObject({
      buildTrigger: "index_upgrade",
      requestedById: null,
    });
  });

  it("attributes a rebuild to the admin behind a recent matching routing change", async () => {
    const tx = snapshotTransaction({
      activeGeneration: { configFingerprint: "previous-fingerprint" },
      routingChangeRecord: {
        userId,
        indexFingerprint: configuration.configFingerprint,
        at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    });

    await ensureGenerationForCurrentConfig(
      {} as never,
      dbForSingleAttempt(tx) as never,
      configuration,
    );

    expect(createdData(tx)).toMatchObject({
      buildTrigger: "embedding_change",
      requestedById: userId,
    });
  });

  it("keeps the embedding-change trigger without a requester whose account was deleted", async () => {
    const tx = snapshotTransaction({
      activeGeneration: { configFingerprint: "previous-fingerprint" },
      routingChangeRecord: {
        userId,
        indexFingerprint: configuration.configFingerprint,
        at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
      requesterDeleted: true,
    });

    await ensureGenerationForCurrentConfig(
      {} as never,
      dbForSingleAttempt(tx) as never,
      configuration,
    );

    expect(tx.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: userId } }),
    );
    expect(createdData(tx)).toMatchObject({
      buildTrigger: "embedding_change",
      requestedById: null,
    });
  });

  it("falls back to an index upgrade once the matching routing-change record is over 24 hours old", async () => {
    const tx = snapshotTransaction({
      activeGeneration: { configFingerprint: "previous-fingerprint" },
      routingChangeRecord: {
        userId,
        indexFingerprint: configuration.configFingerprint,
        at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      },
    });

    await ensureGenerationForCurrentConfig(
      {} as never,
      dbForSingleAttempt(tx) as never,
      configuration,
    );

    expect(createdData(tx)).toMatchObject({
      buildTrigger: "index_upgrade",
      requestedById: null,
    });
  });
});

describe("knowledge generation activation", () => {
  it("keeps the true idempotency contract without reporting another activation", async () => {
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ deletedAt: null }])
        .mockResolvedValueOnce([{ ...generation, status: "active" }])
        .mockResolvedValueOnce([{ total: 0, ready: 0, failed: 0 }])
        .mockResolvedValueOnce([{ count: 0 }]),
      knowledgeGeneration: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const db = {
      $transaction: vi.fn((operation: (client: never) => unknown) =>
        operation(tx as never),
      ),
    };

    await expect(
      activateCompletedGeneration({} as never, db as never, {
        projectId: generation.projectId,
        generationId: generation.id,
      }),
    ).resolves.toBe(true);

    expect(diagnosticOperations.emitDiagnostic).not.toHaveBeenCalled();
  });

  it("reports every superseded generation after a successful activation commit", async () => {
    const supersededIds = [
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ];
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ deletedAt: null }])
        .mockResolvedValueOnce([{ ...generation, status: "building" }])
        .mockResolvedValueOnce([{ total: 0, ready: 0, failed: 0 }])
        .mockResolvedValueOnce([{ count: 0 }]),
      knowledgeGeneration: {
        updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }),
        updateManyAndReturn: vi
          .fn()
          .mockResolvedValue(supersededIds.map((id) => ({ id }))),
        update: vi.fn().mockResolvedValue(generation),
      },
    };
    const db = {
      $transaction: vi.fn((operation: (client: never) => unknown) =>
        operation(tx as never),
      ),
    };

    await activateCompletedGeneration({} as never, db as never, {
      projectId: generation.projectId,
      generationId: generation.id,
    });

    expect(
      diagnosticOperations.emitDiagnostic.mock.calls.map(([event]) => event),
    ).toEqual([
      {
        event: "knowledge.generation.superseded",
        message: "generation 33333333 superseded",
        projectId: generation.projectId,
        generationId: supersededIds[0],
        details: { replacementGenerationId: generation.id },
      },
      {
        event: "knowledge.generation.superseded",
        message: "generation 44444444 superseded",
        projectId: generation.projectId,
        generationId: supersededIds[1],
        details: { replacementGenerationId: generation.id },
      },
      {
        event: "knowledge.generation.activated",
        message: "generation 22222222 activated",
        projectId: generation.projectId,
        generationId: generation.id,
        details: { superseded: 2 },
      },
    ]);
  });

  it.each([0, 1])(
    "activates a failed document only when terminal (count %i)",
    async (terminalCount) => {
      const tx = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ deletedAt: null }])
          .mockResolvedValueOnce([generation])
          .mockResolvedValueOnce([{ total: 1, ready: 0, failed: 1 }])
          .mockResolvedValueOnce([{ count: terminalCount }]),
        knowledgeGeneration: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          updateManyAndReturn: vi.fn().mockResolvedValue([]),
          update: vi.fn().mockResolvedValue(generation),
        },
      };
      const db = {
        $transaction: vi.fn((operation: (client: never) => unknown) =>
          operation(tx as never),
        ),
      };

      await expect(
        activateCompletedGeneration({} as never, db as never, {
          projectId: generation.projectId,
          generationId: generation.id,
        }),
      ).resolves.toBe(terminalCount === 1);
      if (terminalCount === 1) {
        expect(tx.knowledgeGeneration.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: "active",
              documentFailedCount: 1,
            }) as { status: string; documentFailedCount: number },
          }),
        );
      } else {
        expect(tx.knowledgeGeneration.update).not.toHaveBeenCalled();
      }
    },
  );

  it("does not report activation transitions when their transaction rolls back", async () => {
    const rollback = new Error("activation rolled back");
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ deletedAt: null }])
        .mockResolvedValueOnce([{ ...generation, status: "building" }])
        .mockResolvedValueOnce([{ total: 0, ready: 0, failed: 0 }])
        .mockResolvedValueOnce([{ count: 0 }]),
      knowledgeGeneration: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        updateManyAndReturn: vi
          .fn()
          .mockResolvedValue([{ id: "33333333-3333-4333-8333-333333333333" }]),
        update: vi.fn().mockResolvedValue(generation),
      },
    };
    const db = {
      $transaction: vi.fn(async (operation: (client: never) => unknown) => {
        await operation(tx as never);
        throw rollback;
      }),
    };

    await expect(
      activateCompletedGeneration({} as never, db as never, {
        projectId: generation.projectId,
        generationId: generation.id,
      }),
    ).rejects.toBe(rollback);

    expect(diagnosticOperations.emitDiagnostic).not.toHaveBeenCalled();
  });
});
