import { expect, it, vi } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { PrismaClient } from "@weaver/db/client";

const mocked = vi.hoisted(() => ({
  recordUsage: vi.fn(),
  complete: vi.fn().mockResolvedValue({ status: "completed" }),
  fail: vi.fn().mockResolvedValue({ transitioned: false, retrying: false }),
}));
vi.mock("@weaver/core/services/aiUsage", () => ({
  recordAiUsage: mocked.recordUsage,
}));
vi.mock("@weaver/core/assistant/principal", () => ({
  assertLiveAssistantPrincipal: vi.fn(),
}));
vi.mock("@weaver/core/assistant/citations", () => ({
  validateSourceLocators: async () => [],
}));
vi.mock("@weaver/core/services/projects", () => ({
  listProjectsForUser: async () => [],
}));
vi.mock("@weaver/core/services/projectTraining", () => ({
  trainerProjectIds: async () => [],
}));
vi.mock("@weaver/assistant-tools/registry", () => ({
  toolsForActor: () => [],
  examToolsForActor: () => [],
}));
vi.mock("@weaver/core/assistant/scope", () => ({
  effectiveScope: async () => ({ kind: "all", projectIds: [] }),
}));
vi.mock("@weaver/core/services/llmRoutes", () => ({
  resolveLlmRoute: async () => ({
    connectionId: "connection",
    providerType: "openai",
    endpoint: "https://provider.invalid",
    modelId: "model",
    providerModelId: "test",
    contextWindow: 128000,
  }),
}));
vi.mock("@weaver/core/services/assistantRuns", () => ({
  ASSISTANT_LEASE_MS: 30000,
  ASSISTANT_RUN_TIMEOUT_MS: 60000,
  leaseRunAttempt: async () => ({
    run: {
      id: "run",
      conversationId: "conversation",
      scopeSnapshot: { kind: "all", projectIds: [] },
    },
    attempt: { id: "attempt", number: 1 },
    actor: { userId: "user", credentialId: "session", capabilities: [] },
    user: { name: "Tester", email: "tester@example.test" },
    history: [
      {
        role: "user",
        text: "Answer",
        status: "pending",
        contextProjectIds: [],
        proposalIds: [],
        citationIds: [],
      },
    ],
  }),
  setRunRouteSnapshot: vi.fn(),
  heartbeatAttempt: async () => "running",
  appendRunEvent: async () => ({ runStatus: "running" }),
  completeRun: mocked.complete,
  persistRunAttemptFailure: mocked.fail,
  cancelRunFromWorker: vi.fn(),
  dispatchAssistantRun: vi.fn(),
}));
import { executeAssistantRun } from "./runner";

it("keeps a committed successful run successful when final usage retries fail", async () => {
  mocked.recordUsage
    .mockResolvedValueOnce(undefined)
    .mockRejectedValue(new Error("accounting unavailable"));
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: "Completed answer" },
          { type: "text-end", id: "text" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: {
                total: 10,
                noCache: 10,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: 5, reasoning: undefined },
            },
          },
        ],
      }),
    }),
  });
  await expect(
    executeAssistantRun(
      {
        db: {} as PrismaClient,
        ring: null,
        workerId: "worker",
        modelFactory: () => model,
      },
      "run",
    ),
  ).resolves.toBeUndefined();
  expect(mocked.fail.mock.calls).toEqual([]);
  expect(mocked.complete).toHaveBeenCalledOnce();
  expect(mocked.complete).toHaveBeenCalledWith(
    {},
    expect.objectContaining({ text: "Completed answer" }),
  );
  expect(mocked.fail).not.toHaveBeenCalled();
  expect(mocked.recordUsage).toHaveBeenCalledTimes(4);
});
