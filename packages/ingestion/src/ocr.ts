import { generateText, type LanguageModel } from "ai";
import type { PrismaClient } from "@weaver/db/client";
import { classifyRunError } from "@weaver/ai/errors";
import { modelOutputFailure } from "@weaver/ai/completion";
import { createAssistantLanguageModel } from "@weaver/ai/model";
import { usageFromSdk } from "@weaver/ai/usage";
import { emptyUsage } from "@weaver/core/ai/http";
import { createDbCredentialSource } from "@weaver/core/ai/registry";
import { emitDiagnostic } from "@weaver/core/diagnostics/writer";
import { recordAiUsageSafely } from "@weaver/core/services/aiUsageBestEffort";
import { ingestionRouteFingerprint } from "@weaver/core/ingestion/route";
import type { EncryptionKeyRing } from "@weaver/core/security/encryption";
import {
  recordAiUsage,
  type RecordAiUsageInput,
} from "@weaver/core/services/aiUsage";
import {
  resolveLlmRoute,
  type LlmModelSnapshot,
} from "@weaver/core/services/llmRoutes";

export const OCR_PROMPT =
  "Transcribe all text in this image as Markdown. Preserve headings, paragraphs, lists, and tables (use GFM tables). Keep the original language and reading order. Output only the transcription, without commentary or code fences.";
export const OCR_MAX_OUTPUT_TOKENS = 8_192;

export type OcrRoute = { snapshot: LlmModelSnapshot; model: LanguageModel };
export type OcrUnavailable = { failureKind: "configuration"; message: string };
export type OcrInput = {
  png: Uint8Array;
  projectId: string;
  fileId: string;
  jobId: string | null;
  page: number | null;
};
export type OcrPageResult =
  { markdown: string } | { failureKind: "provider"; message: string };
export type OcrClient = {
  resolve(): Promise<OcrRoute | OcrUnavailable>;
  transcribe(
    route: OcrRoute,
    input: OcrInput,
    signal: AbortSignal,
  ): Promise<OcrPageResult>;
};
export type OcrClientDeps = {
  db: PrismaClient;
  ring: EncryptionKeyRing | null;
  fetchImpl?: typeof fetch;
  modelFactory?: (snapshot: LlmModelSnapshot) => LanguageModel;
  resolveRoute?: () => Promise<LlmModelSnapshot | null>;
  // Broader return type than `typeof recordAiUsage` so a test double returning void still fits.
  recordUsage?: (
    db: PrismaClient,
    input: RecordAiUsageInput,
  ) => Promise<unknown>;
};

/** Models often wrap transcripts in a fence despite instructions; strip one outer fence. */
export function cleanTranscript(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

export function createOcrClient(deps: OcrClientDeps): OcrClient {
  const resolveRoute =
    deps.resolveRoute ?? (() => resolveLlmRoute(deps.db, "ingestion"));
  const recordUsage = deps.recordUsage ?? recordAiUsage;
  return {
    async resolve() {
      const snapshot = await resolveRoute();
      if (!snapshot) {
        return {
          failureKind: "configuration",
          message:
            "Scanned pages and images need a model on the Import parsing route in Administration › AI",
        };
      }
      if (!snapshot.capabilities.includes("vision")) {
        return {
          failureKind: "configuration",
          message: `Model ${snapshot.displayName} on the Import parsing route does not declare the Vision capability`,
        };
      }
      const model = deps.modelFactory
        ? deps.modelFactory(snapshot)
        : createAssistantLanguageModel(
            snapshot,
            createDbCredentialSource(deps.db, deps.ring),
            deps.fetchImpl,
          );
      return { snapshot, model };
    },
    async transcribe(route, input, signal) {
      const started = Date.now();
      const accounting = {
        projectId: input.projectId,
        operation: "ingestion.ocr",
        jobId: input.jobId,
        connectionId: route.snapshot.connectionId,
        provider: route.snapshot.providerType,
        model: route.snapshot.providerModelId,
        configFingerprint: ingestionRouteFingerprint(route.snapshot),
        pricing: {
          inputCostMicrosPerMillion: route.snapshot.inputCostMicrosPerMillion,
          outputCostMicrosPerMillion: route.snapshot.outputCostMicrosPerMillion,
        },
        currency: route.snapshot.currency,
      };
      let result: Awaited<ReturnType<typeof generateText>>;
      try {
        result = await generateText({
          model: route.model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: OCR_PROMPT },
                { type: "file", mediaType: "image/png", data: input.png },
              ],
            },
          ],
          abortSignal: signal,
          maxOutputTokens: route.snapshot.maxOutputTokens
            ? Math.min(route.snapshot.maxOutputTokens, OCR_MAX_OUTPUT_TOKENS)
            : OCR_MAX_OUTPUT_TOKENS,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        const failure = classifyRunError(error);
        await recordAiUsageSafely(
          deps.db,
          {
            ...accounting,
            usage: emptyUsage(Date.now() - started),
            outcome: "provider_failure",
          },
          recordUsage,
        );
        emitDiagnostic({
          event: "ingestion.ocr.failed",
          severity: "warn",
          message: "OCR provider request failed",
          outcome: "error",
          projectId: input.projectId,
          jobId: input.jobId ?? undefined,
          durationMs: Date.now() - started,
          details: {
            fileId: input.fileId,
            page: input.page,
            failureKind: "provider",
          },
        });
        return { failureKind: "provider", message: failure.message };
      }
      signal.throwIfAborted();
      const markdown = cleanTranscript(result.text);
      const failure = modelOutputFailure(
        {
          finishReason: result.finishReason,
          text: markdown,
        },
        { allowEmpty: true },
      );
      await recordAiUsageSafely(
        deps.db,
        {
          ...accounting,
          usage: usageFromSdk(result.usage, Date.now() - started),
          outcome: failure ? "validation_failure" : "success",
        },
        recordUsage,
      );
      emitDiagnostic({
        event: failure ? "ingestion.ocr.failed" : "ingestion.ocr.completed",
        severity: failure ? "warn" : "info",
        message: failure ? "OCR output was rejected" : "OCR page transcribed",
        outcome: failure ? "error" : "ok",
        projectId: input.projectId,
        jobId: input.jobId ?? undefined,
        durationMs: Date.now() - started,
        details: {
          fileId: input.fileId,
          page: input.page,
          failureKind: failure ? "incomplete_output" : null,
        },
      });
      return failure
        ? { failureKind: "provider", message: failure }
        : { markdown };
    },
  };
}
