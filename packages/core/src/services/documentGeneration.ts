import { createHash } from "node:crypto";
import type { PrismaClient } from "@weaver/db/client";
import { emptyUsage } from "../ai/http";
import {
  createAdapterForSnapshot,
  createDbCredentialSource,
} from "../ai/registry";
import { AiProviderError, type TextCompletionResult } from "../ai/types";
import { withDiagnosticContext } from "../diagnostics/context";
import { CoreError } from "../errors";
import type { EncryptionKeyRing } from "../security/encryption";
import { recordAiUsageSafely } from "./aiUsageBestEffort";
import { assertAssistantUse } from "./assistantConversations";
import { assertEditableMarkdownDocument } from "./documents";
import { resolveLlmRoute } from "./llmRoutes";
import type { ProjectActor } from "./projectAccess";

const MAX_OUTPUT_TOKENS = 4_096;
const MESSAGE_OVERHEAD_TOKENS = 128;
const SYSTEM_PROMPT = [
  "Generate the content the user asks to insert into a Weaver Markdown document.",
  "Return only the requested Markdown fragment, without a conversational preamble or a wrapping Markdown code fence.",
  "Use ordinary Markdown syntax for prose, lists, tables, links, and code. Include a language fence when the requested content is a code block. Do not emit raw HTML or YAML front matter.",
  "For LaTeX math, use $...$ inline or put each $$ delimiter on its own line for display math. Use syntax supported by KaTeX.",
  'For a graph of a mathematical expression, emit a fenced ```plot block containing one JSON object. For y=f(x), use {"type":"cartesian","expression":"sin(x)","x":[-6,6],"y":[-2,2]}. The y range is optional.',
  'For a parametric curve, use {"type":"parametric","xExpression":"cos(t)","yExpression":"sin(t)","t":[0,6.2831853]}. Add x and y ranges to fix the displayed axes. For a 3D surface z=f(x,y), use {"type":"surface","expression":"sin(x)*cos(y)","x":[-5,5],"y":[-5,5]}. The z range is optional.',
  'Plot expressions use explicit multiplication, ^ for powers, pi and e constants, and functions such as sin, cos, tan, sqrt, abs, exp, and log. The expression fields contain expressions only. Optional "title" labels the plot. To add sliders, declare parameters used in the expressions, for example "parameters":{"a":{"min":0,"max":3,"value":1,"step":0.1}}.',
  "For diagrams, use a fenced ```mermaid block containing valid Mermaid syntax and a closing fence.",
].join("\n");

export async function generateDocumentContent(
  db: PrismaClient,
  input: { projectId: string; documentId: string; instruction: string },
  actor: ProjectActor,
  deps: {
    ring: EncryptionKeyRing | null;
    fetchImpl: typeof fetch;
    signal?: AbortSignal;
  },
): Promise<{ markdown: string }> {
  await assertEditableMarkdownDocument(db, input, actor);
  assertAssistantUse(actor);
  const route = await resolveLlmRoute(db, "assistant");
  if (!route)
    throw new CoreError(
      "PRECONDITION_FAILED",
      "No Assistant model is configured",
    );

  const promptTokens =
    Buffer.byteLength(SYSTEM_PROMPT) +
    Buffer.byteLength(input.instruction) +
    MESSAGE_OVERHEAD_TOKENS;
  const maxOutputTokens = Math.min(
    MAX_OUTPUT_TOKENS,
    route.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
    (route.contextWindow ?? Infinity) - promptTokens,
  );
  if (maxOutputTokens <= 0)
    throw new CoreError(
      "BAD_REQUEST",
      "The instructions exceed the Assistant model's context window",
      {
        field: "instruction",
      },
    );

  // The Anthropic completion adapter accepts ordinary text blocks.
  const reasoning =
    route.providerType === "anthropic" ? undefined : route.reasoningMode;
  const accounting = {
    projectId: input.projectId,
    documentId: input.documentId,
    operation: "document.generate_content",
    connectionId: route.connectionId,
    provider: route.providerType,
    model: route.providerModelId,
    configFingerprint: createHash("sha256")
      .update(
        JSON.stringify([
          "document-generation-v2",
          route.providerType,
          route.endpoint,
          route.providerModelId,
          route.upstreamProvider,
          reasoning,
        ]),
      )
      .digest("hex"),
    pricing: route,
    currency: route.currency,
  };
  const started = Date.now();
  let completion: TextCompletionResult;
  try {
    completion = await withDiagnosticContext(
      {
        suppressProviderBodies: true,
        projectId: input.projectId,
        documentId: input.documentId,
      },
      () =>
        createAdapterForSnapshot(
          route,
          createDbCredentialSource(db, deps.ring),
          deps.fetchImpl,
        ).completeText(
          route.providerModelId,
          { system: SYSTEM_PROMPT, prompt: input.instruction, maxOutputTokens },
          { signal: deps.signal, reasoning },
        ),
    );
  } catch (error) {
    if (error instanceof AiProviderError)
      await recordAiUsageSafely(db, {
        ...accounting,
        usage: error.usage ?? emptyUsage(Date.now() - started),
        outcome:
          error.kind === "validation"
            ? "validation_failure"
            : "provider_failure",
      });
    throw new CoreError(
      "INTERNAL_SERVER_ERROR",
      "The Assistant could not generate document content",
    );
  }
  await recordAiUsageSafely(db, {
    ...accounting,
    usage: completion.usage,
    outcome: deps.signal?.aborted ? "stale_discarded" : "success",
  });
  if (deps.signal?.aborted)
    throw new CoreError(
      "INTERNAL_SERVER_ERROR",
      "Document generation was cancelled",
    );
  return { markdown: completion.text };
}
