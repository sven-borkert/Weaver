import { randomUUID } from "node:crypto";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { WikiRunnerDeps } from "@weaver/ai/wikiRunner";
import { createLlmModel } from "@weaver/core/services/llmConnections";
import { setLlmRoute } from "@weaver/core/services/llmRoutes";
import {
  getPrisma,
  securityContextFor,
  seedTestLlmRouting,
  testEncryptionKeys,
} from "./_harness";
import type { ToolOutput } from "./_wikiRunHarness";

export type Call = [string, Record<string, unknown>];
export type PromptPart = {
  type: string;
  toolCallId: string;
  toolName: string;
  output: { type: string; value: ToolOutput };
};
export type PromptMessage = { role: string; content: string | PromptPart[] };
export type ScriptContext = {
  /** Latest result per tool name, parsed. */
  results: Map<string, ToolOutput>;
  prompt: PromptMessage[];
};
export type Step = (context: ScriptContext) => Call[] | string;

export const USAGE = {
  inputTokens: {
    total: 100,
    noCache: 100,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

export function toolParts(message: PromptMessage): PromptPart[] {
  return message.role === "tool" && typeof message.content !== "string"
    ? message.content.filter((part) => part.type === "tool-result")
    : [];
}

export function resultsOf(prompt: PromptMessage[]): Map<string, ToolOutput> {
  const results = new Map<string, ToolOutput>();
  for (const message of prompt)
    for (const part of toolParts(message))
      results.set(part.toolName, part.output.value);
  return results;
}

/** Replays a script; each step sees the prompt the model would have seen. */
export function scripted(steps: Step[]) {
  const prompts: PromptMessage[][] = [];
  const toolNames: string[][] = [];
  let counter = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const prompt = options.prompt as unknown as PromptMessage[];
      prompts.push(prompt);
      toolNames.push((options.tools ?? []).map((tool) => tool.name));
      const step = steps[Math.min(counter, steps.length - 1)]!;
      const action =
        counter < steps.length
          ? step({ results: resultsOf(prompt), prompt })
          : "done";
      counter += 1;
      const chunks: unknown[] =
        typeof action === "string"
          ? [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: action },
              { type: "text-end", id: "t" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: USAGE,
              },
            ]
          : [
              ...action.map(([toolName, input], index) => ({
                type: "tool-call",
                toolCallId: `call-${counter}-${index}`,
                toolName,
                input: JSON.stringify(input),
              })),
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: undefined },
                usage: USAGE,
              },
            ];
      return { stream: simulateReadableStream({ chunks }) as never };
    },
  });
  return { model, prompts, toolNames };
}

/** A model call that hangs until it is aborted. */
export function stallingModel(onStart: () => void) {
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream({
        start(controller) {
          onStart();
          const fail = () =>
            controller.error(abortSignal?.reason ?? new Error("aborted"));
          if (abortSignal?.aborted) fail();
          else abortSignal?.addEventListener("abort", fail);
        },
      }) as never,
    }),
  });
}

export async function seedWikiRoute(
  input: { contextWindow?: number; maxOutputTokens?: number } = {},
) {
  const seeded = await seedTestLlmRouting({
    pricing: { input: 1_000_000, output: 1_000_000, currency: "USD" },
  });
  const db = getPrisma();
  const actor = securityContextFor(seeded.admin);
  const model = await createLlmModel(db, actor, {
    connectionId: seeded.connection.id,
    providerModelId: `wiki-${randomUUID().slice(0, 8)}`,
    displayName: "Wiki",
    contextWindow: input.contextWindow ?? 200_000,
    maxOutputTokens: input.maxOutputTokens ?? 16_000,
    capabilities: ["chat", "tool_use"],
    inputCostMicrosPerMillion: 1_000_000,
    outputCostMicrosPerMillion: 1_000_000,
    currency: "USD",
  });
  await setLlmRoute(db, actor, { purpose: "wiki", modelId: model.id });
}

export function deps(
  model: unknown,
  extra: Partial<WikiRunnerDeps> = {},
): WikiRunnerDeps {
  return {
    db: getPrisma(),
    ring: testEncryptionKeys(),
    workerId: "spec-worker",
    modelFactory: () => model as never,
    ...extra,
  };
}
