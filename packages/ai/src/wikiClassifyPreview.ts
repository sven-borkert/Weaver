import { generateText } from "ai";
import { emptyUsage } from "@weaver/core/ai/http";
import { createDbCredentialSource } from "@weaver/core/ai/registry";
import type { AiUsageSample } from "@weaver/core/ai/types";
import { withDiagnosticContext } from "@weaver/core/diagnostics/context";
import { emitDiagnostic } from "@weaver/core/diagnostics/writer";
import { isClosedFence } from "@weaver/core/services/wikiRuns";
import { recordAiUsage } from "@weaver/core/services/aiUsage";
import {
  resolveLlmRoute,
  type LlmModelSnapshot,
} from "@weaver/core/services/llmRoutes";
import {
  assertClassifyPreviewFence,
  claimClassifyPreview,
  heartbeatClassifyPreview,
  loadClassifyCandidates,
  storeClassifyPlan,
  type ClassifyPreviewClaim,
} from "@weaver/core/services/wikiClassify";
import { endRun } from "@weaver/core/services/wikiRuns";
import {
  buildClassifyPlan,
  buildClassifyUserMessage,
  CLASSIFY_SYSTEM_PROMPT,
  type ClassifyCandidate,
} from "@weaver/core/wiki/classifyPlan";
import { classifyRunError, redactSecrets } from "./errors";
import { createAssistantLanguageModel } from "./model";
import { usageFromError, usageFromSdk } from "./usage";
import {
  routeFingerprint,
  routeUnsuitableReason,
  usageId,
} from "./wikiRunShared";
import type { WikiRunnerDeps } from "./wikiRunner";

const PREVIEW_OUTPUT_TOKENS_MAX = 8_192;
const PREVIEW_WALL_CLOCK_MS = 15 * 60_000;

/** The largest prefix of candidates whose message fits the window (a byte is charged as a token). */
export function fitClassifyCandidates(
  candidates: readonly ClassifyCandidate[],
  budgetBytes: number,
): ClassifyCandidate[] {
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const size = Buffer.byteLength(
      buildClassifyUserMessage(candidates.slice(0, middle)),
      "utf8",
    );
    if (size <= budgetBytes) low = middle;
    else high = middle - 1;
  }
  return candidates.slice(0, low);
}

/** The preview: one model call with no tools whose reply becomes the stored plan. */
export async function executeClassifyPreview(
  deps: WikiRunnerDeps,
  runId: string,
  externalSignal?: AbortSignal,
): Promise<void> {
  const { db } = deps;
  const claim = await claimClassifyPreview(db, {
    runId,
    workerId: deps.workerId,
    leaseMs: deps.leaseMs,
  });
  if (!claim) return;
  await withDiagnosticContext(
    {
      suppressProviderBodies: true,
      runId,
      projectId: claim.projectId,
      credentialId: `wiki-run:${runId}`,
    },
    () => preview(deps, claim, externalSignal),
  );
}

async function preview(
  deps: WikiRunnerDeps,
  claim: ClassifyPreviewClaim,
  externalSignal?: AbortSignal,
): Promise<void> {
  const { db } = deps;
  const started = Date.now();
  const controller = new AbortController();
  let shutdown = false;
  const onExternal = () => {
    shutdown = true;
    controller.abort(new Error("worker shutting down"));
  };
  if (externalSignal?.aborted) onExternal();
  externalSignal?.addEventListener("abort", onExternal, { once: true });
  const heartbeat = setInterval(() => {
    void heartbeatClassifyPreview(db, claim, deps.leaseMs).then(
      (held) => {
        if (!held) controller.abort(new Error("lease lost"));
      },
      () => undefined,
    );
  }, deps.heartbeatMs ?? 15_000);
  const wall = setTimeout(
    () => controller.abort(new Error("wall clock")),
    PREVIEW_WALL_CLOCK_MS,
  );
  const end = (
    status: "stopped" | "failed",
    detail: {
      stopReason?: string;
      errorCode?: string;
      errorMessage?: string;
    },
  ) =>
    endRun(db, claim.id, ["preparing"], {
      status,
      leaseToken: claim.leaseToken,
      note: "The classification ended.",
      ...detail,
    });
  let route: LlmModelSnapshot | null = null;
  let usage: AiUsageSample | null = null;
  let called = false;
  try {
    await assertClassifyPreviewFence(db, claim);
    const settings = await db.projectWikiSettings.findUnique({
      where: { projectId: claim.projectId },
      select: { destructivePausedAt: true },
    });
    if (settings?.destructivePausedAt) {
      await end("stopped", { stopReason: "destructive_pause" });
      return;
    }
    route = await resolveLlmRoute(db, "wiki");
    const unsuitable = routeUnsuitableReason(route);
    if (unsuitable) {
      await end("failed", {
        errorCode: "ROUTE_UNSUITABLE",
        errorMessage: unsuitable,
      });
      return;
    }
    const all = await loadClassifyCandidates(db, claim.projectId);
    const maxOutputTokens = Math.min(
      route!.maxOutputTokens!,
      PREVIEW_OUTPUT_TOKENS_MAX,
    );
    const budget =
      route!.contextWindow! -
      maxOutputTokens -
      Buffer.byteLength(CLASSIFY_SYSTEM_PROMPT, "utf8") -
      2_048;
    const candidates = fitClassifyCandidates(all, budget);
    if (candidates.length === 0) {
      await end("stopped", { stopReason: "no_candidates" });
      return;
    }
    const model = deps.modelFactory
      ? deps.modelFactory(route!)
      : createAssistantLanguageModel(
          route!,
          createDbCredentialSource(db, deps.ring),
          deps.fetchImpl,
        );
    called = true;
    const result = await generateText({
      model,
      system: CLASSIFY_SYSTEM_PROMPT,
      messages: [
        { role: "user", content: buildClassifyUserMessage(candidates) },
      ],
      maxOutputTokens,
      abortSignal: controller.signal,
    });
    usage = usageFromSdk(result.usage, Date.now() - started);
    controller.signal.throwIfAborted();
    const plan = buildClassifyPlan(result.text, candidates);
    await assertClassifyPreviewFence(db, claim);
    if (plan.entries.length === 0) {
      await end("stopped", { stopReason: "no_proposals" });
      return;
    }
    if (!(await storeClassifyPlan(db, claim, plan)))
      throw new Error("the preview lost its claim before storing the plan");
    emitDiagnostic({
      event: "wiki.run.started",
      message: "wiki classify plan ready",
      outcome: "ok",
      projectId: claim.projectId,
      details: {
        runId: claim.id,
        kind: "classify",
        pages: plan.entries.length,
      },
    });
  } catch (error) {
    if (shutdown) return;
    if (isClosedFence(error) || controller.signal.aborted) {
      // Whoever closed the fence ended or reset the run; a lost lease is released by the tick.
      return;
    }
    const failed = usageFromError(error, Date.now() - started);
    if (failed) usage = failed;
    const failure = classifyRunError(error);
    await end("failed", {
      errorCode: failure.code.slice(0, 64),
      errorMessage: redactSecrets(failure.message),
    });
  } finally {
    clearInterval(heartbeat);
    clearTimeout(wall);
    externalSignal?.removeEventListener("abort", onExternal);
    if (route && called)
      await recordPreviewUsage(deps, claim, route, usage).catch(
        () => undefined,
      );
  }
}

async function recordPreviewUsage(
  deps: WikiRunnerDeps,
  claim: ClassifyPreviewClaim,
  route: LlmModelSnapshot,
  usage: AiUsageSample | null,
): Promise<void> {
  const { db } = deps;
  await recordAiUsage(db, {
    id: usageId(claim.id, claim.attempt),
    projectId: claim.projectId,
    operation: "wiki.run",
    runId: claim.id,
    connectionId: route.connectionId,
    provider: route.providerType,
    model: route.providerModelId,
    configFingerprint: routeFingerprint(route),
    usage: usage ?? emptyUsage(0),
    outcome: usage ? "success" : "provider_failure",
    pricing: {
      inputCostMicrosPerMillion: route.inputCostMicrosPerMillion,
      outputCostMicrosPerMillion: route.outputCostMicrosPerMillion,
    },
    currency: route.currency,
  });
  const { _sum: sum } = await db.aiUsage.aggregate({
    where: { runId: claim.id, operation: "wiki.run" },
    _sum: { totalTokens: true, costMicros: true },
  });
  await db.wikiRun.update({
    where: { id: claim.id },
    data: {
      usageTokens: sum.totalTokens ?? 0,
      usageCostMicros: sum.costMicros ?? 0n,
      routeSnapshot: {
        providerType: route.providerType,
        providerModelId: route.providerModelId,
        displayName: route.displayName,
        contextWindow: route.contextWindow,
        maxOutputTokens: route.maxOutputTokens ?? null,
        currency: route.currency,
      },
    },
  });
}
