import { createHash } from "node:crypto";
import {
  isStepCount,
  streamText,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { z } from "zod";
import {
  WIKI_AGENT_DISPATCH,
  WIKI_AGENT_TOOLS,
  wikiAgentToolContext,
  type WikiAgentToolContext,
} from "@weaver/assistant-tools/wikiAgentRegistry";
import { emptyUsage } from "@weaver/core/ai/http";
import { createDbCredentialSource } from "@weaver/core/ai/registry";
import type { AiUsageSample } from "@weaver/core/ai/types";
import {
  bindDiagnosticContext,
  withDiagnosticContext,
} from "@weaver/core/diagnostics/context";
import { emitDiagnostic } from "@weaver/core/diagnostics/writer";
import { summarizeError } from "@weaver/core/diagnostics/errorSummary";
import { isCoreError } from "@weaver/core/errors";
import type { WikiRunner } from "@weaver/core/jobs/types";
import type { EncryptionKeyRing } from "@weaver/core/security/encryption";
import { recordAiUsage } from "@weaver/core/services/aiUsage";
import {
  resolveLlmRoute,
  type LlmModelSnapshot,
} from "@weaver/core/services/llmRoutes";
import {
  buildRestartBriefing,
  lintStartContext,
  readRunGuide,
  reconcileReservedOperations,
  wikiIndexHead,
} from "@weaver/core/services/wikiRunStart";
import { WikiRunSession } from "@weaver/core/services/wikiRunSession";
import {
  assertLiveWikiRun,
  endRun,
  heartbeatWikiRun,
  closedFence,
  isClosedFence,
  leaseWikiRun,
  WIKI_RUN_HEARTBEAT_MS,
  WIKI_RUN_LEASE_MS,
  type LeasedWikiRun,
} from "@weaver/core/services/wikiRuns";
import { WIKI_RUN_CAPS } from "@weaver/core/wiki/caps";
import { classifyRunError, redactSecrets } from "./errors";
import { createAssistantLanguageModel } from "./model";
import { assertPromptFits, promptByteSize } from "./prompt";
import { toAiToolSet, type ToolCollector } from "./tools";
import { accumulateUsage, usageFromError, usageFromSdk } from "./usage";
import { elideMessages, exemptResults } from "./wikiElision";
import {
  buildWikiNotesMessage,
  buildWikiStartMessage,
  buildWikiSystemPrompt,
  WIKI_NOTES_HEADER,
} from "./wikiPrompt";

export const WIKI_MIN_CONTEXT_WINDOW = 100_000;
export const WIKI_MIN_OUTPUT_TOKENS = 8_192;
const WIKI_SCHEMA_RESERVE_CAP = 32 * 1024;
const WIKI_PROMPT_VERSION = "wiki-v1";
const RETURN_NOTE = "This run ended before the input was finished.";

export type WikiRunnerDeps = {
  db: Parameters<typeof resolveLlmRoute>[0] &
    Parameters<typeof leaseWikiRun>[0];
  ring: EncryptionKeyRing | null;
  workerId: string;
  fetchImpl?: typeof fetch;
  modelFactory?: (snapshot: LlmModelSnapshot) => LanguageModel;
  leaseMs?: number;
  heartbeatMs?: number;
};

export function wikiToolDefinitions(names?: ReadonlySet<string>): string {
  return JSON.stringify(
    WIKI_AGENT_DISPATCH.filter(
      (tool) =>
        WIKI_AGENT_TOOLS.includes(tool) || names?.has(tool.name) === true,
    ).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema),
    })),
  );
}

/** One byte is charged as one token; loading tools draws on the reserve held back here. */
export function wikiContextBudget(input: {
  contextWindow: number;
  maxOutputTokens: number;
  instructions: string;
  toolDefinitions: string;
}): { maxInputBytes: number; maxOutputTokens: number; schemaReserve: number } {
  const maxOutputTokens = Math.min(
    input.maxOutputTokens,
    Math.floor(input.contextWindow / 8),
  );
  const schemaReserve = Math.min(
    WIKI_SCHEMA_RESERVE_CAP,
    Math.floor(input.contextWindow / 8),
  );
  const maxInputBytes =
    input.contextWindow -
    Buffer.byteLength(input.instructions, "utf8") -
    Buffer.byteLength(input.toolDefinitions, "utf8") -
    schemaReserve -
    1024 -
    maxOutputTokens;
  return { maxInputBytes, maxOutputTokens, schemaReserve };
}

export function routeUnsuitableReason(
  route: LlmModelSnapshot | null,
): string | null {
  if (!route) return "no model is routed to the wiki agent";
  if ((route.contextWindow ?? 0) < WIKI_MIN_CONTEXT_WINDOW)
    return `the wiki model needs a context window of at least ${WIKI_MIN_CONTEXT_WINDOW}`;
  if ((route.maxOutputTokens ?? 0) < WIKI_MIN_OUTPUT_TOKENS)
    return `the wiki model needs a maximum output of at least ${WIKI_MIN_OUTPUT_TOKENS} tokens`;
  return null;
}

/** Notes come back as a user-role message each step, one block only, never in the system prompt. */
export function withNotesMessage(
  messages: readonly ModelMessage[],
  note: string | null,
): ModelMessage[] {
  const kept = messages.filter(
    (message) =>
      !(
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.startsWith(WIKI_NOTES_HEADER)
      ),
  );
  if (!note) return kept;
  return [
    ...kept.slice(0, 1),
    { role: "user", content: buildWikiNotesMessage(note) },
    ...kept.slice(1),
  ];
}

class WikiRunStop extends Error {
  constructor(
    readonly status: "stopped" | "failed",
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WikiRunStop";
  }
}

function usageId(runId: string, attempt: number): string {
  const hex = createHash("sha256")
    .update(`wiki-run-usage:${runId}:${attempt}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function routeFingerprint(route: LlmModelSnapshot): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        route.providerType,
        route.endpoint,
        route.providerModelId,
        WIKI_PROMPT_VERSION,
      ]),
    )
    .digest("hex");
}

async function runAttempt(input: {
  deps: WikiRunnerDeps;
  lease: LeasedWikiRun;
  route: LlmModelSnapshot;
  signal: AbortSignal;
  onSession: (session: WikiRunSession) => void;
  onProviderStart: () => void;
  onStepUsage: (usage: AiUsageSample) => Promise<void>;
}): Promise<{
  session: WikiRunSession;
  stepCapped: boolean;
}> {
  const { deps, lease, route, signal } = input;
  const db = deps.db;
  const caps = WIKI_RUN_CAPS[lease.kind];
  const guide = await readRunGuide(db, lease.projectId);
  if (guide === null)
    throw new WikiRunStop(
      "failed",
      "GUIDE_UNAVAILABLE",
      "the approved wiki guide is missing or no longer matches its approval",
    );
  const instructions = buildWikiSystemPrompt({
    kind: lease.kind,
    guide,
    indexHead: await wikiIndexHead(db, lease.projectId),
  });
  const budget = wikiContextBudget({
    contextWindow: route.contextWindow!,
    maxOutputTokens: route.maxOutputTokens!,
    instructions,
    toolDefinitions: wikiToolDefinitions(),
  });
  const session = new WikiRunSession(db, lease, budget.schemaReserve);
  input.onSession(session);
  const collector: ToolCollector = { citations: [], proposals: [] };
  const tools = toAiToolSet<WikiAgentToolContext>(WIKI_AGENT_DISPATCH, {
    collector,
    onEvent: async () => undefined,
    context: async () => {
      signal.throwIfAborted();
      await session.assertLive();
      return wikiAgentToolContext(session);
    },
  });
  const alwaysActive = WIKI_AGENT_TOOLS.map((tool) => tool.name);
  const briefing =
    lease.attempt > 1
      ? await buildRestartBriefing(
          db,
          lease.id,
          lease.kind === "lint" ? "lint" : "ingest",
        )
      : null;
  const lint =
    lease.kind === "lint"
      ? await lintStartContext(db, lease.id, lease.projectId)
      : undefined;
  const remainingSteps = (caps.steps ?? 1) - lease.steps;
  if (remainingSteps <= 0)
    throw new WikiRunStop(
      "stopped",
      "step_cap",
      "the run reached its step cap",
    );
  const model = deps.modelFactory
    ? deps.modelFactory(route)
    : createAssistantLanguageModel(
        route,
        createDbCredentialSource(db, deps.ring),
        deps.fetchImpl,
      );
  const startedAt = Date.now();
  const result = streamText({
    model,
    onLanguageModelCallStart: input.onProviderStart,
    instructions,
    messages: [
      { role: "user", content: buildWikiStartMessage(briefing, lint) },
    ],
    maxOutputTokens: budget.maxOutputTokens,
    tools,
    abortSignal: signal,
    onError: () => undefined,
    stopWhen: [
      isStepCount(remainingSteps),
      () => session.finished !== null || session.stopRequested !== null,
    ],
    prepareStep: bindDiagnosticContext(async ({ messages, steps }) => {
      await assertLiveWikiRun(db, lease);
      const note = await session.currentNote();
      const noted = withNotesMessage(messages, note);
      const sourceIds = new Set<string>();
      if (session.currentItemId) {
        const item = await db.wikiInputItem.findUnique({
          where: { id: session.currentItemId },
          select: { sourceDocumentId: true, sourceTableId: true },
        });
        if (item?.sourceDocumentId) sourceIds.add(item.sourceDocumentId);
        if (item?.sourceTableId) sourceIds.add(item.sourceTableId);
      }
      const elided = elideMessages(noted, {
        maxInputBytes: budget.maxInputBytes,
        parallelCalls: Math.max(1, steps.at(-1)?.toolCalls.length ?? 1),
        exemptIds: exemptResults(noted, {
          currentItemId: session.currentItemId,
          sourceIds,
          maxInputBytes: budget.maxInputBytes,
        }),
      });
      try {
        assertPromptFits(elided, budget.maxInputBytes);
      } catch {
        throw new WikiRunStop(
          "failed",
          "CONTEXT_LIMIT",
          `the prompt does not fit the model's context window (${promptByteSize(elided)} of ${budget.maxInputBytes} bytes)`,
        );
      }
      return {
        messages: elided,
        activeTools: [...alwaysActive, ...session.loadedTools],
      };
    }),
    onStepFinish: async ({ usage }) => {
      await db.wikiRun.update({
        where: { id: lease.id },
        data: { steps: { increment: 1 } },
      });
      await input.onStepUsage(usageFromSdk(usage, Date.now() - startedAt));
    },
  });
  for await (const part of result.stream) {
    if (part.type === "error") throw part.error;
    if (part.type === "abort") throw signal.reason ?? new Error("aborted");
  }
  const steps = await result.steps;
  return {
    session,
    stepCapped:
      steps.length >= remainingSteps &&
      session.finished === null &&
      session.stopRequested === null,
  };
}

export function createWikiRunner(deps: WikiRunnerDeps): WikiRunner {
  return (payload, execution) =>
    executeWikiRun(deps, payload.runId, execution.signal);
}

export async function executeWikiRun(
  deps: WikiRunnerDeps,
  runId: string,
  externalSignal?: AbortSignal,
): Promise<void> {
  const { db } = deps;
  const leaseMs = deps.leaseMs ?? WIKI_RUN_LEASE_MS;
  const lease = await leaseWikiRun(db, {
    runId,
    workerId: deps.workerId,
    leaseMs,
  });
  if (!lease) return;
  await withDiagnosticContext(
    {
      suppressProviderBodies: true,
      runId,
      projectId: lease.projectId,
      credentialId: `wiki-run:${runId}`,
    },
    async () => {
      const started = Date.now();
      const controller = new AbortController();
      let shutdown = false;
      let fenceClosed = false;
      let wallClock = false;
      let session: WikiRunSession | null = null;
      const onExternal = () => {
        shutdown = true;
        controller.abort(new Error("worker shutting down"));
      };
      if (externalSignal?.aborted) onExternal();
      externalSignal?.addEventListener("abort", onExternal, { once: true });
      const caps = WIKI_RUN_CAPS[lease.kind];
      const wallRemaining =
        caps.wallClockMs - (Date.now() - lease.runningAt.getTime());
      const wallTimer = setTimeout(
        () => {
          wallClock = true;
          controller.abort(new Error("wall clock"));
        },
        Math.max(0, wallRemaining),
      );
      // Disable, revoke, cancel or a lost lease reach the in-flight model call here.
      let lastHeartbeat = Date.now();
      const heartbeat = setInterval(
        bindDiagnosticContext(() => {
          void (async () => {
            const held = await heartbeatWikiRun(db, lease, leaseMs);
            if (!held) throw closedFence("The run's lease is gone");
            lastHeartbeat = Date.now();
            await assertLiveWikiRun(db, lease);
          })().catch((error: unknown) => {
            // Other errors are retried until the lease itself would have lapsed.
            if (!isClosedFence(error) && Date.now() - lastHeartbeat <= leaseMs)
              return;
            fenceClosed = true;
            controller.abort(new Error("wiki run fence closed"));
          });
        }),
        deps.heartbeatMs ?? WIKI_RUN_HEARTBEAT_MS,
      );

      let consumed: AiUsageSample | null = null;
      let providerStarted = false;
      let route: LlmModelSnapshot | null = null;
      const persistUsage = async (
        outcome: "success" | "stale_discarded" | "provider_failure",
      ) => {
        if (!route || !providerStarted) return;
        await recordAiUsage(db, {
          id: usageId(lease.id, lease.attempt),
          projectId: lease.projectId,
          operation: "wiki.run",
          runId: lease.id,
          connectionId: route.connectionId,
          provider: route.providerType,
          model: route.providerModelId,
          configFingerprint: routeFingerprint(route),
          usage: {
            ...(consumed ?? emptyUsage(0)),
            durationMs: Date.now() - started,
          },
          outcome,
          pricing: {
            inputCostMicrosPerMillion: route.inputCostMicrosPerMillion,
            outputCostMicrosPerMillion: route.outputCostMicrosPerMillion,
          },
          currency: route.currency,
        });
        const { _sum: sum } = await db.aiUsage.aggregate({
          where: { runId: lease.id, operation: "wiki.run" },
          _sum: { totalTokens: true, costMicros: true },
        });
        await db.wikiRun.update({
          where: { id: lease.id },
          data: {
            usageTokens: sum.totalTokens ?? 0,
            usageCostMicros: sum.costMicros ?? 0n,
          },
        });
      };
      const end = (
        status: "succeeded" | "stopped" | "failed" | "cancelled",
        detail: {
          stopReason?: string;
          errorCode?: string;
          errorMessage?: string;
          summary?: string;
          note?: string;
        },
      ) =>
        endRun(db, lease.id, ["running"], {
          status,
          leaseToken: lease.leaseToken,
          note: detail.note ?? RETURN_NOTE,
          ...detail,
        });
      let usageOutcome: "success" | "stale_discarded" | "provider_failure" =
        "stale_discarded";
      try {
        emitDiagnostic({
          event: "wiki.run.started",
          message: "wiki run started",
          details: {
            attempt: lease.attempt,
            kind: lease.kind,
            workerId: deps.workerId,
          },
        });
        await assertLiveWikiRun(db, lease);
        const settings = await db.projectWikiSettings.findUnique({
          where: { projectId: lease.projectId },
          select: { destructivePausedAt: true },
        });
        if (lease.attempt === 1 && settings?.destructivePausedAt)
          throw new WikiRunStop(
            "stopped",
            "destructive_pause",
            "changes in the last 24 hours exceed the project's budget",
          );
        route = await resolveLlmRoute(db, "wiki");
        const unsuitable = routeUnsuitableReason(route);
        if (unsuitable)
          throw new WikiRunStop("failed", "ROUTE_UNSUITABLE", unsuitable);
        await db.wikiRun.update({
          where: { id: lease.id },
          data: {
            routeSnapshot: {
              providerType: route!.providerType,
              providerModelId: route!.providerModelId,
              displayName: route!.displayName,
              contextWindow: route!.contextWindow,
              maxOutputTokens: route!.maxOutputTokens ?? null,
              currency: route!.currency,
            },
          },
        });
        await reconcileReservedOperations(db, lease);
        const { stepCapped } = await runAttempt({
          deps,
          lease,
          route: route!,
          signal: controller.signal,
          onSession: (created) => {
            session = created;
          },
          onProviderStart: () => {
            providerStarted = true;
          },
          onStepUsage: async (usage) => {
            consumed = accumulateUsage(consumed, usage);
            await persistUsage("stale_discarded");
          },
        });
        controller.signal.throwIfAborted();
        usageOutcome = "success";
        const active = session as WikiRunSession | null;
        if (active?.finished) {
          const unfinished = await db.wikiInputItem.count({
            where: {
              runId: lease.id,
              status: { notIn: ["processed", "skipped"] },
            },
          });
          if (unfinished > 0)
            await end("stopped", {
              stopReason: "unfinished_items",
              summary: active.finished.summary,
            });
          else await end("succeeded", { summary: active.finished.summary });
        } else if (active?.stopRequested)
          await end("stopped", { stopReason: active.stopRequested });
        else
          await end("stopped", {
            stopReason: stepCapped ? "step_cap" : "model_stopped",
          });
      } catch (error) {
        const failed = usageFromError(error, Date.now() - started);
        if (failed) consumed = accumulateUsage(consumed, failed);
        if (shutdown) return;
        if (wallClock) {
          usageOutcome = "success";
          await end("stopped", { stopReason: "wall_clock" });
          return;
        }
        if (fenceClosed || isClosedFence(error)) {
          // Whoever closed the fence owns a cancelled run; only a disabled feature leaves one running.
          await end("cancelled", { stopReason: "fence_closed" });
          return;
        }
        if (error instanceof WikiRunStop) {
          usageOutcome =
            error.status === "failed" ? "provider_failure" : "success";
          await end(error.status, {
            ...(error.status === "stopped"
              ? { stopReason: error.code }
              : { errorCode: error.code, errorMessage: error.message }),
          });
          return;
        }
        usageOutcome = "provider_failure";
        const failure = classifyRunError(error);
        emitDiagnostic({
          event: "wiki.run.failed",
          severity: "warn",
          message: `wiki run attempt failed: ${failure.code}`,
          outcome: "error",
          details: {
            code: failure.code,
            ...(isCoreError(error) ? {} : { error: summarizeError(error) }),
          },
        });
        await end("failed", {
          errorCode: failure.code.slice(0, 64),
          errorMessage: redactSecrets(failure.message),
        });
      } finally {
        clearInterval(heartbeat);
        clearTimeout(wallTimer);
        externalSignal?.removeEventListener("abort", onExternal);
        await persistUsage(usageOutcome).catch(() => undefined);
      }
    },
  );
}
