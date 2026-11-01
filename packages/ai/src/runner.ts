import { assertLiveAssistantPrincipal } from "@weaver/core/assistant/principal";
import {
  createExternalMcpTransport,
  type ExternalMcpTransport,
} from "@weaver/external-mcp";
import { CoreError } from "@weaver/core/errors";
import { mergeContextProjectIds } from "@weaver/core/externalMcp/historyScope";
import { createExternalToolkit, findToolDefinition } from "./externalTools";
import { externalSchemaReserve } from "./externalToolSearch";
import type { ExternalSource } from "@weaver/core/externalMcp/types";
import { z } from "zod";
import { isStepCount, streamText, type LanguageModel } from "ai";
import type { PrismaClient } from "@weaver/db/client";
import type { AiUsageSample } from "@weaver/core/ai/types";
import { emptyUsage } from "@weaver/core/ai/http";
import { createDbCredentialSource } from "@weaver/core/ai/registry";
import { validateSourceLocators } from "@weaver/core/assistant/citations";
import type { AssistantEvent } from "@weaver/core/assistant/events";
import {
  assistantRouteFingerprint,
  assistantRouteSnapshot,
} from "@weaver/core/assistant/route";
import { effectiveScope } from "@weaver/core/assistant/scope";
import {
  bindDiagnosticContext,
  withDiagnosticContext,
} from "@weaver/core/diagnostics/context";
import {
  emitDiagnostic,
  reserveDiagnosticEvent,
} from "@weaver/core/diagnostics/writer";
import { withReference } from "@weaver/core/diagnostics/reference";
import { summarizeError } from "@weaver/core/diagnostics/errorSummary";
import type { AssistantRunner } from "@weaver/core/jobs/types";
import type { EncryptionKeyRing } from "@weaver/core/security/encryption";
import { recordAiUsage } from "@weaver/core/services/aiUsage";
import {
  listAvailableExternalTools,
  loadExternalToolsForRun,
  ownsEnabledExternalConnection,
} from "@weaver/core/services/externalMcp";
import {
  appendRunEvent,
  cancelRunFromWorker,
  completeRun,
  dispatchAssistantRun,
  heartbeatAttempt,
  leaseRunAttempt,
  persistRunAttemptFailure,
  setRunRouteSnapshot,
  ASSISTANT_LEASE_MS,
  ASSISTANT_RUN_TIMEOUT_MS,
  type LeasedRun,
} from "@weaver/core/services/assistantRuns";
import {
  resolveLlmRoute,
  type LlmModelSnapshot,
} from "@weaver/core/services/llmRoutes";
import { listProjectsForUser } from "@weaver/core/services/projects";
import {
  toolsForActor,
  examToolsForActor,
} from "@weaver/assistant-tools/registry";
import { trainerProjectIds } from "@weaver/core/services/projectTraining";
import {
  classifyRunError,
  redactSecrets,
  RunCancelledError,
  RunTimeoutError,
} from "./errors";
import { createAssistantLanguageModel } from "./model";
import {
  buildInstructions,
  budgetModelMessages,
  assertPromptFits,
  type ExternalPrompt,
} from "./prompt";
import { toAiToolSet, type ToolCollector } from "./tools";
import { accumulateUsage, usageFromSdk, usageFromError } from "./usage";

export type AssistantRunnerDeps = {
  db: PrismaClient;
  ring: EncryptionKeyRing | null;
  workerId: string;
  fetchImpl?: typeof fetch;
  externalTransport?: ExternalMcpTransport;
  modelFactory?: (snapshot: LlmModelSnapshot) => LanguageModel;
  leaseMs?: number;
  heartbeatMs?: number;
  maxSteps?: number;
  runTimeoutMs?: number;
  textFlushChars?: number;
};

// A runaway guard, not a working budget: the run timeout and the context window bound real runs.
export const ASSISTANT_MAX_STEPS = 200;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_FLUSH_CHARS = 400;
/** reduceRunEvents replays deltas verbatim, so no delta may reach the
 * MAX_EVENT_PAYLOAD_CHARS (8_000) truncation ceiling even fully JSON-escaped. */
const MAX_TEXT_DELTA_CHARS = 1_000;

const ROUTE_MISSING = "PROVIDER_UNAVAILABLE";

export function createAssistantRunner(
  deps: AssistantRunnerDeps,
): AssistantRunner {
  return (payload, execution) =>
    executeAssistantRun(deps, payload.runId, execution.signal);
}

function textDelta(part: Record<string, unknown>): string | null {
  if (part.type !== "text-delta") return null;
  const value = part.text;
  return typeof value === "string" ? value : null;
}

function isRouteMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === ROUTE_MISSING
  );
}

export async function executeAssistantRun(
  deps: AssistantRunnerDeps,
  runId: string,
  externalSignal?: AbortSignal,
): Promise<void> {
  const leaseMs = deps.leaseMs ?? ASSISTANT_LEASE_MS;
  const leased = await leaseRunAttempt(deps.db, {
    runId,
    workerId: deps.workerId,
    leaseMs,
  });
  if (!leased) return;
  const externalPossible =
    Boolean(deps.ring) &&
    (await ownsEnabledExternalConnection(deps.db, leased.actor.userId));
  const historyExternal = leased.history.some(
    (message) => message.hasExternalContext,
  );
  const contextProjectIds = mergeContextProjectIds(
    leased.history,
    leased.run.scopeSnapshot,
  );
  return withDiagnosticContext(
    {
      runId,
      bodyProjectIds: contextProjectIds,
      suppressProviderBodies: externalPossible || historyExternal,
      projectId:
        leased.run.scopeSnapshot.projectIds.length === 1
          ? leased.run.scopeSnapshot.projectIds[0]
          : undefined,
      userId: leased.actor.userId,
      credentialId: leased.actor.credentialId,
    },
    async () => {
      const { db } = deps;
      const startedAt = Date.now();
      emitDiagnostic({
        event: "assistant.attempt.started",
        message: `attempt ${leased.attempt.number} started`,
        details: { attempt: leased.attempt.number, workerId: deps.workerId },
      });
      const controller = new AbortController();
      let cancelRequested = false;
      let terminal: "succeeded" | "failed" | "abandoned" | "cancelled" | null =
        null;
      let transitionPending: "succeeded" | "failed" | "cancelled" | null = null;
      let abandonPending = false;
      // Set when this attempt no longer owns the run: it must then write nothing at all.
      let abandoned = false;
      let stopped = false;
      // Only a user cancellation observed on the run row (`cancelling`) may take the
      // terminal cancel path; everything else abandons or fails.
      const cancel = () => {
        cancelRequested = true;
        // The reason must be a RunCancelledError: a bare abort() raises an
        // AbortError, which classifyRunError treats as a retryable provider fault.
        controller.abort(new RunCancelledError());
      };
      const publishAbandoned = () => {
        terminal = "abandoned";
        emitDiagnostic({
          event: "assistant.attempt.abandoned",
          severity: "warn",
          message: `attempt ${leased.attempt.number} abandoned`,
          durationMs: Date.now() - startedAt,
          outcome: "cancelled",
          details: { attempt: leased.attempt.number },
        });
      };
      const finishTransition = (
        result: "succeeded" | "failed" | "cancelled" | null,
      ): void => {
        transitionPending = null;
        if (result !== null) {
          terminal = result;
          abandonPending = false;
        } else if (abandonPending) {
          publishAbandoned();
        }
      };
      const abandon = bindDiagnosticContext(() => {
        if (terminal !== null) return;
        abandoned = true;
        controller.abort(new RunCancelledError());
        if (transitionPending !== null) {
          abandonPending = true;
          return;
        }
        publishAbandoned();
      });
      // The job signal aborts on worker shutdown, not on user intent: abandon the
      // attempt so its lease expires and the reconciler requeues the run. Cancelling
      // here would end every in-flight run terminally on an ordinary deploy, and
      // unrecoverably — the requeued job would find a terminal run to lease.
      externalSignal?.addEventListener("abort", abandon, { once: true });
      // A signal aborted before this point never fires the listener above.
      if (externalSignal?.aborted) abandon();
      const timeout = setTimeout(
        () => controller.abort(new RunTimeoutError()),
        deps.runTimeoutMs ?? ASSISTANT_RUN_TIMEOUT_MS,
      );
      const heartbeat = setInterval(() => {
        void heartbeatAttempt(db, { attemptId: leased.attempt.id, leaseMs })
          .then((status) => {
            if (stopped) return;
            if (status === "cancelling") cancel();
            // Lease lost: the reconciler abandoned this attempt and the run
            // belongs to the next one.
            if (status === null) abandon();
          })
          .catch((error: unknown) => {
            if (error instanceof CoreError && !stopped) controller.abort(error);
          });
      }, deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);

      const emit = async (event: AssistantEvent) => {
        const appended = await appendRunEvent(db, {
          runId,
          attemptId: leased.attempt.id,
          event,
        });
        // `null` means the run is terminal or this attempt lost its lease.
        if (appended === null) {
          abandon();
          return;
        }
        if (appended.runStatus === "cancelling") cancel();
      };

      let route: LlmModelSnapshot | null = null;
      let consumedUsage: AiUsageSample | null = null;
      let providerStarted = false;
      const persistUsage = async (
        outcome: "success" | "stale_discarded" | "provider_failure",
      ) => {
        if (!route || !providerStarted) return;
        for (let retry = 0; ; retry++) {
          try {
            await recordAiUsage(db, {
              id: leased.attempt.id,
              projectId:
                leased.run.scopeSnapshot.projectIds.length === 1
                  ? leased.run.scopeSnapshot.projectIds[0]
                  : null,
              operation: "assistant.run",
              runId,
              connectionId: route.connectionId,
              provider: route.providerType,
              model: route.providerModelId,
              configFingerprint: assistantRouteFingerprint(route),
              usage: {
                ...(consumedUsage ?? emptyUsage(0)),
                durationMs: Date.now() - startedAt,
              },
              outcome,
              pricing: {
                inputCostMicrosPerMillion: route.inputCostMicrosPerMillion,
                outputCostMicrosPerMillion: route.outputCostMicrosPerMillion,
              },
              currency: route.currency,
            });
            return;
          } catch (error) {
            if (retry >= 2) throw error;
          }
        }
      };
      try {
        route = await resolveLlmRoute(db, "assistant");
        if (!route)
          throw Object.assign(new Error("no ready assistant route"), {
            code: ROUTE_MISSING,
          });
        await setRunRouteSnapshot(db, runId, assistantRouteSnapshot(route));
        const resolvedRoute = route;
        const model = () =>
          deps.modelFactory
            ? deps.modelFactory(resolvedRoute)
            : createAssistantLanguageModel(
                resolvedRoute,
                createDbCredentialSource(db, deps.ring),
                deps.fetchImpl,
              );
        const turn = await runTurn({
          deps,
          leased,
          model,
          contextWindow: route.contextWindow,
          maxOutputTokens: route.maxOutputTokens,
          externalPossible,
          emit,
          onProviderStart: () => {
            providerStarted = true;
          },
          onStepUsage: async (usage) => {
            consumedUsage = accumulateUsage(consumedUsage, usage);
            await persistUsage("stale_discarded");
          },
          signal: controller.signal,
          deadline: new Date(
            startedAt + (deps.runTimeoutMs ?? ASSISTANT_RUN_TIMEOUT_MS),
          ),
        });
        controller.signal.throwIfAborted();
        if (abandoned) return;
        await assertLiveAssistantPrincipal(db, leased.actor);
        const citations = await validateSourceLocators(
          db,
          leased.actor,
          turn.collector.citations,
        );
        await emit({
          type: "usage",
          inputTokens: turn.usage.inputTokens,
          outputTokens: turn.usage.outputTokens,
        });
        if (abandoned) return;
        if (cancelRequested) throw new RunCancelledError();
        controller.signal.throwIfAborted();
        transitionPending = "succeeded";
        let completed = false;
        try {
          const outcome = await completeRun(db, {
            runId,
            attemptId: leased.attempt.id,
            text: turn.text,
            usageId: leased.attempt.id,
            citations,
            externalSources: turn.collector.externalSources,
            hasExternalContext: turn.externalLoaded || historyExternal,
            contextProjectIds,
            proposalIds: turn.collector.proposals.map((p) => p.proposalId),
          });
          completed = outcome.status === "completed";
          if (!completed) {
            finishTransition("cancelled");
            emitDiagnostic({
              event: "assistant.attempt.cancelled",
              message: `attempt ${leased.attempt.number} cancelled`,
              durationMs: Date.now() - startedAt,
              outcome: "cancelled",
            });
          }
        } catch (error) {
          finishTransition(null);
          throw error;
        }
        if (completed) {
          finishTransition("succeeded");
          emitDiagnostic({
            event: "assistant.attempt.succeeded",
            message: `attempt ${leased.attempt.number} succeeded`,
            durationMs: Date.now() - startedAt,
            outcome: "ok",
            details: { attempt: leased.attempt.number },
          });
        }
      } catch (error) {
        const failedUsage = usageFromError(error, Date.now() - startedAt);
        if (failedUsage)
          consumedUsage = accumulateUsage(consumedUsage, failedUsage);
        if (terminal !== null) return;
        const failure = cancelRequested
          ? { code: "CANCELLED", message: "cancelled", retryable: false }
          : classifyRunError(error);
        if (!cancelRequested && isRouteMissing(error))
          failure.code = ROUTE_MISSING;
        const reserved = cancelRequested
          ? null
          : reserveDiagnosticEvent("error");
        // External context can put private content in an error message, so its
        // summary stays out of the event just as the raw console line did.
        const externalContext = externalPossible || historyExternal;
        if (failure.code === "INTERNAL")
          console.error(
            `assistant run ${runId} failed unclassified (ref ${reserved?.reference ?? "none"})`,
          );
        if (failure.code === "CANCELLED") {
          transitionPending = "cancelled";
          let cancelled;
          try {
            cancelled = await cancelRunFromWorker(db, {
              runId,
              attemptId: leased.attempt.id,
            });
          } catch (transitionError) {
            finishTransition(null);
            throw transitionError;
          }
          if (cancelled.transitioned) {
            finishTransition("cancelled");
            emitDiagnostic({
              event: "assistant.attempt.cancelled",
              message: `attempt ${leased.attempt.number} cancelled`,
              durationMs: Date.now() - startedAt,
              outcome: "cancelled",
              details: { attempt: leased.attempt.number },
            });
          } else {
            finishTransition(null);
          }
        } else {
          transitionPending = "failed";
          let failed;
          try {
            failed = await persistRunAttemptFailure(db, {
              runId,
              attemptId: leased.attempt.id,
              code: failure.code,
              // persistRunAttemptFailure stores this in AssistantRun.errorMessage
              // and the run.failed payload; this is the only redaction point.
              message: withReference(
                redactSecrets(failure.message),
                reserved?.reference ?? null,
                300,
              ),
              retryable: failure.retryable,
            });
          } catch (transitionError) {
            finishTransition(null);
            throw transitionError;
          }
          if (failed.transitioned && failed.cancelled) {
            finishTransition("cancelled");
            emitDiagnostic({
              event: "assistant.attempt.cancelled",
              message: `attempt ${leased.attempt.number} cancelled`,
              durationMs: Date.now() - startedAt,
              outcome: "cancelled",
            });
          } else if (failed.transitioned) {
            finishTransition("failed");
            emitDiagnostic({
              id: reserved?.id,
              event: "assistant.attempt.failed",
              severity: "error",
              message: `attempt ${leased.attempt.number} failed: ${failure.code}`,
              durationMs: Date.now() - startedAt,
              outcome: "error",
              details: {
                attempt: leased.attempt.number,
                code: failure.code,
                retryable: failure.retryable,
                reference: reserved?.reference ?? null,
                ...(externalContext ? {} : { error: summarizeError(error) }),
              },
            });
          } else {
            finishTransition(null);
          }
          if (failed.retrying) await dispatchAssistantRun(db, runId);
        }
      } finally {
        stopped = true;
        clearInterval(heartbeat);
        clearTimeout(timeout);
        externalSignal?.removeEventListener("abort", abandon);
        await persistUsage(
          terminal === "succeeded"
            ? "success"
            : terminal === "cancelled" || terminal === "abandoned"
              ? "stale_discarded"
              : "provider_failure",
        );
      }
    },
  );
}

async function offerExternalTools(
  deps: AssistantRunnerDeps,
  leased: LeasedRun,
): Promise<
  | {
      kind: "offered";
      available: Awaited<ReturnType<typeof listAvailableExternalTools>>;
    }
  | { kind: "unavailable"; reason: "history" }
  | null
> {
  try {
    const available = await listAvailableExternalTools(
      { db: deps.db, now: () => new Date() },
      leased.actor,
      {
        scope: leased.run.scopeSnapshot,
        conversationId: leased.run.conversationId,
      },
    );
    return available.tools.length ? { kind: "offered", available } : null;
  } catch (error) {
    if (!(error instanceof CoreError)) throw error;
    return error.details?.reason === "EXTERNAL_HISTORY_SCOPE"
      ? { kind: "unavailable", reason: "history" }
      : null;
  }
}

async function runTurn(input: {
  deps: AssistantRunnerDeps;
  leased: LeasedRun;
  model: () => LanguageModel;
  contextWindow: number | null;
  maxOutputTokens?: number | null;
  externalPossible: boolean;
  emit: (event: AssistantEvent) => Promise<void>;
  signal: AbortSignal;
  deadline: Date;
  onStepUsage: (usage: AiUsageSample) => Promise<void>;
  onProviderStart: () => void;
}) {
  const { deps, leased, emit } = input;
  const startedAt = Date.now();
  const flushChars = Math.max(
    1,
    Math.min(deps.textFlushChars ?? DEFAULT_FLUSH_CHARS, MAX_TEXT_DELTA_CHARS),
  );
  let text = "";
  let buffer = "";
  const flushFull = async () => {
    while (buffer.length >= flushChars) {
      const chunk = buffer.slice(0, flushChars);
      buffer = buffer.slice(flushChars);
      await emit({ type: "text.delta", text: chunk });
    }
  };
  const flushAll = async () => {
    await flushFull();
    if (!buffer) return;
    const chunk = buffer;
    buffer = "";
    await emit({ type: "text.delta", text: chunk });
  };

  const emitToolEvent = async (event: AssistantEvent) => {
    await flushAll();
    await emit(event);
  };
  const projects = await listProjectsForUser(deps.db, leased.actor);
  const initialScope = await effectiveScope(
    deps.db,
    leased.actor,
    leased.run.scopeSnapshot,
  );
  const collector: ToolCollector & { externalSources: ExternalSource[] } = {
    citations: [],
    proposals: [],
    externalSources: [],
  };
  const trainerProjects = await trainerProjectIds(
    deps.db,
    leased.actor,
    initialScope.projectIds,
  );
  const contracts = [
    ...toolsForActor(leased.actor),
    ...(trainerProjects.length ? examToolsForActor(leased.actor) : []),
  ];
  const tools = toAiToolSet(contracts, {
    collector,
    onEvent: emitToolEvent,
    // Scope is re-intersected with live membership on every call (spec §12),
    // so losing project access takes effect mid-run.
    context: async () => {
      input.signal.throwIfAborted();
      await assertLiveAssistantPrincipal(deps.db, leased.actor);
      return {
        db: deps.db,
        actor: leased.actor,
        scope: await effectiveScope(
          deps.db,
          leased.actor,
          leased.run.scopeSnapshot,
        ),
        profile: { name: leased.user.name, email: leased.user.email },
        run: {
          conversationId: leased.run.conversationId,
          runId: leased.run.id,
          attemptId: leased.attempt.id,
        },
      };
    },
  });

  const nativeNames = Object.keys(tools);
  const nativeDefinitions = contracts.map((contract) => ({
    name: contract.name,
    description: contract.description,
    inputSchema: z.toJSONSchema(contract.inputSchema),
  }));
  const offer = input.externalPossible
    ? await offerExternalTools(deps, leased)
    : null;
  let available = offer?.kind === "offered" ? offer.available : null;
  const instructionsFor = (external: ExternalPrompt | undefined) =>
    buildInstructions({
      scope: initialScope,
      projects: projects
        .filter((p) => initialScope.projectIds.includes(p.id))
        .map((p) => ({ id: p.id, name: p.name })),
      userName: leased.user.name,
      examTools: trainerProjects.length > 0,
      external,
      canPropose: contracts.some((tool) => tool.kind === "propose"),
    });
  const offeredPrompt = (
    offered: NonNullable<typeof available>,
  ): ExternalPrompt => ({
    kind: "offered",
    connections: offered.connections.map((connection) => ({
      name: connection.name,
      toolCount: offered.tools.filter((t) => t.connectionId === connection.id)
        .length,
    })),
  });
  const reserveBytes =
    available && input.contextWindow !== null
      ? externalSchemaReserve(input.contextWindow)
      : 0;
  let instructions = instructionsFor(
    available
      ? offeredPrompt(available)
      : offer?.kind === "unavailable"
        ? { kind: "unavailable", reason: offer.reason }
        : undefined,
  );
  let budget: ReturnType<typeof budgetModelMessages>;
  try {
    budget = budgetModelMessages(leased.history, {
      contextWindow: input.contextWindow,
      maxOutputTokens: input.maxOutputTokens,
      instructions,
      toolDefinitions: JSON.stringify(
        available
          ? [...nativeDefinitions, findToolDefinition()]
          : nativeDefinitions,
      ),
      reservedBytes: reserveBytes,
    });
  } catch (error) {
    if (
      !available ||
      !(error instanceof CoreError) ||
      error.code !== "BAD_REQUEST"
    )
      throw error;
    available = null;
    instructions = instructionsFor({ kind: "unavailable", reason: "context" });
    budget = budgetModelMessages(leased.history, {
      contextWindow: input.contextWindow,
      maxOutputTokens: input.maxOutputTokens,
      instructions,
      toolDefinitions: JSON.stringify(nativeDefinitions),
    });
  }
  const toolkit =
    available && deps.ring
      ? createExternalToolkit({
          deps: {
            db: deps.db,
            ring: deps.ring,
            transport:
              deps.externalTransport ??
              createExternalMcpTransport({
                fetchImpl: deps.fetchImpl ?? fetch,
              }),
            now: () => new Date(),
          },
          actor: leased.actor,
          run: { id: leased.run.id, attemptId: leased.attempt.id },
          scope: leased.run.scopeSnapshot,
          available,
          tools,
          stored: leased.run.externalToolSnapshots,
          reserveBytes,
          load: (snapshots) =>
            loadExternalToolsForRun(
              { db: deps.db, now: () => new Date() },
              leased.actor,
              { runId: leased.run.id, attemptId: leased.attempt.id, snapshots },
            ),
          beforeTool: () => assertLiveAssistantPrincipal(deps.db, leased.actor),
          collector,
          onEvent: emitToolEvent,
          signal: input.signal,
          deadline: input.deadline,
        })
      : null;
  if (toolkit) Object.assign(tools, toolkit.tools);
  const result = streamText({
    model: input.model(),
    onLanguageModelCallStart: input.onProviderStart,
    ...(toolkit ? { maxRetries: 0 } : {}),
    instructions,
    messages: budget.messages,
    maxOutputTokens: budget.maxOutputTokens,
    prepareStep: bindDiagnosticContext(async ({ messages }) => {
      await assertLiveAssistantPrincipal(deps.db, leased.actor);
      assertPromptFits(messages, budget.maxInputBytes);
      return toolkit
        ? { activeTools: [...nativeNames, ...toolkit.activeToolNames()] }
        : {};
    }),
    tools,
    stopWhen: isStepCount(deps.maxSteps ?? ASSISTANT_MAX_STEPS),
    abortSignal: input.signal,
    // The SDK default writes provider errors to console.error; the stream loop
    // below owns the failure and nothing credential-shaped may reach a log line.
    onError: () => undefined,
    onStepFinish: async ({ usage }) =>
      input.onStepUsage(usageFromSdk(usage, Date.now() - startedAt)),
  });

  for await (const part of result.stream) {
    const delta = textDelta(part);
    if (delta !== null) {
      text += delta;
      buffer += delta;
      await flushFull();
      continue;
    }
    // Keep deltas ordered ahead of the tool events the adapter emits.
    await flushAll();
    if (part.type === "error") throw part.error;
    if (
      part.type === "tool-error" &&
      part.toolName.startsWith("ext_") &&
      toolkit?.executionFailed()
    ) {
      input.signal.throwIfAborted();
      throw new CoreError(
        "PRECONDITION_FAILED",
        "External tool execution is unavailable or its configuration changed. Send a new message to retry.",
      );
    }
    if (part.type === "abort")
      throw input.signal.reason ?? new RunCancelledError();
  }
  const finishReason = await result.finishReason;
  const steps = await result.steps;
  const note =
    finishReason === "length"
      ? "\n\n[The response reached the model output limit. Ask to continue.]"
      : steps.length >= (deps.maxSteps ?? ASSISTANT_MAX_STEPS) &&
          finishReason === "tool-calls"
        ? "\n\n[The assistant reached its tool-step limit before finishing. Ask to continue.]"
        : "";
  text += note;
  buffer += note;
  await flushAll();
  const usage = usageFromSdk(await result.totalUsage, Date.now() - startedAt);
  return {
    text,
    usage,
    collector,
    externalLoaded: toolkit?.loadedAny() ?? false,
  };
}
