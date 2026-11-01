import { generateText, type LanguageModel } from "ai";
import { z } from "zod";
import type { PrismaClient } from "@weaver/db/client";
import { classifyRunError } from "@weaver/ai/errors";
import { modelOutputFailure } from "@weaver/ai/completion";
import { recordAiUsageSafely } from "@weaver/core/services/aiUsageBestEffort";
import { createAssistantLanguageModel } from "@weaver/ai/model";
import { usageFromSdk } from "@weaver/ai/usage";
import { emptyUsage } from "@weaver/core/ai/http";
import { createDbCredentialSource } from "@weaver/core/ai/registry";
import {
  emitDiagnostic,
  reserveDiagnosticEvent,
} from "@weaver/core/diagnostics/writer";
import { withReference } from "@weaver/core/diagnostics/reference";
import { summarizeError } from "@weaver/core/diagnostics/errorSummary";
import { documentTitleSchema } from "@weaver/core/documents/title";
import { inferColumnTypes } from "@weaver/core/ingestion/columnTypes";
import {
  MAX_LINK_QUERIES,
  MAX_LINK_QUERY_CHARS,
} from "@weaver/core/ingestion/links";
import {
  INGESTION_ANALYZE_PROMPT_VERSION,
  ingestionRouteFingerprint,
  ingestionRouteSnapshot,
} from "@weaver/core/ingestion/route";
import type { IngestionAnalyzeRunner } from "@weaver/core/jobs/types";
import type { EncryptionKeyRing } from "@weaver/core/security/encryption";
import {
  recordAiUsage,
  type RecordAiUsageInput,
} from "@weaver/core/services/aiUsage";
import {
  claimFileForAnalysis,
  completeAnalysis,
  failFile,
  recordParseAttemptDetails,
  type ClaimedDraftFile,
} from "@weaver/core/services/ingestion";
import { listDraftFolders } from "@weaver/core/services/ingestionFolders";
import {
  resolveLlmRoute,
  type LlmModelSnapshot,
} from "@weaver/core/services/llmRoutes";
import { cleanTranscript } from "./ocr";
import { publishStage } from "./publish";

export const ANALYZE_MAX_INPUT_CHARS = 24_000;
export const ANALYZE_MAX_OUTPUT_TOKENS = 1_024;
const SAMPLE_ROWS = 20;

export const ANALYZE_SYSTEM_PROMPT = [
  "You are Weaver's import analyst. You receive one imported file and must propose how it is filed in a knowledge project.",
  "Respond with exactly one JSON object and nothing else: no prose, no code fence. The object has these fields:",
  '- "title": a concise document or table title in the content\'s language, 1 to 200 characters, one line, no file extension.',
  '- "folder": one path copied exactly from the listed existing folders, or "" for the project root. Never invent a folder.',
  '- "linkQueries": 0 to 5 short search phrases (2 to 6 words each) naming the topics, products, people, or systems the content is about, used to find related documents.',
].join("\n");

export const analysisSchema = z.object({
  title: documentTitleSchema.refine((value) => !value.includes("\t")),
  folder: z.string().max(500),
  linkQueries: z
    .array(z.string().trim().min(1).max(MAX_LINK_QUERY_CHARS))
    .max(MAX_LINK_QUERIES)
    .default([]),
});
export type Analysis = z.infer<typeof analysisSchema>;

/** Models wrap or narrate JSON despite instructions; take the outermost object and validate it. */
export function parseAnalysis(text: string): Analysis | null {
  const cleaned = cleanTranscript(text);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = analysisSchema.safeParse(
      JSON.parse(cleaned.slice(start, end + 1)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type AnalysisMessageInput = {
  fileName: string;
  targetKind: "document" | "table";
  folders: string[];
  excerpt: string;
  columns?: string[];
  sampleRows?: string[][];
};

/** Every untrusted draft field shares one prompt budget, including tables and folders. */
export function analysisUserMessage(input: AnalysisMessageInput): string {
  let message = "";
  const append = (line: string) => {
    const remaining = ANALYZE_MAX_INPUT_CHARS - message.length;
    if (remaining <= 0) return;
    message += line.slice(0, remaining);
  };
  append(
    `File name: ${input.fileName}\nKind: ${input.targetKind}\nExisting folders (choose one exactly, or "" for the root):\n`,
  );
  if (input.folders.length === 0) append('(none: use "")\n');
  for (const folder of input.folders) append(`- ${folder}\n`);
  if (input.targetKind === "table") {
    append(`Columns: ${(input.columns ?? []).join(" | ")}\nSample rows:\n`);
    for (const row of (input.sampleRows ?? []).slice(0, SAMPLE_ROWS))
      append(`${row.join(" | ")}\n`);
  } else append(`Content excerpt:\n"""\n${input.excerpt}\n"""`);
  return message;
}

export type IngestionAnalyzeRunnerDeps = {
  db: PrismaClient;
  ring: EncryptionKeyRing | null;
  fetchImpl?: typeof fetch;
  modelFactory?: (snapshot: LlmModelSnapshot) => LanguageModel;
  resolveRoute?: () => Promise<LlmModelSnapshot | null>;
  recordUsage?: (
    db: PrismaClient,
    input: RecordAiUsageInput,
  ) => Promise<unknown>;
};

function tableExcerpt(draft: ClaimedDraftFile["draft"]): string {
  return (draft.rows ?? [])
    .slice(0, SAMPLE_ROWS)
    .map((row) => row.join(" | "))
    .join("\n");
}

export function createIngestionAnalyzeRunner(
  deps: IngestionAnalyzeRunnerDeps,
): IngestionAnalyzeRunner {
  const resolveRoute =
    deps.resolveRoute ?? (() => resolveLlmRoute(deps.db, "ingestion"));
  const recordUsage = deps.recordUsage ?? recordAiUsage;
  return async (payload, execution) => {
    execution.signal.throwIfAborted();
    const started = Date.now();
    const delivery =
      execution.jobId !== null && execution.retryCount !== null
        ? { jobId: execution.jobId, retryCount: execution.retryCount }
        : undefined;
    const file = await claimFileForAnalysis(deps.db, payload.fileId, {
      expectedProjectId: payload.projectId,
      expectedContentDigest: payload.contentDigest,
      baseAttemptCount: payload.baseAttemptCount,
      delivery,
    });
    if (!file) return;
    execution.signal.throwIfAborted();
    const { draft } = file;
    const folders = await listDraftFolders(
      deps.db,
      file.projectId,
      draft.targetKind,
    );
    const warnings: string[] = [];
    let degradedAnalysis = false;
    let analysis: Analysis | null = null;
    const snapshot = await resolveRoute();
    if (!snapshot) {
      warnings.push(
        "AI analysis skipped: no model is routed to Import parsing in Administration › AI",
      );
    } else {
      await recordParseAttemptDetails(deps.db, {
        fileId: file.id,
        attemptCount: file.attemptCount,
        status: "extracting",
        routeSnapshot: ingestionRouteSnapshot(
          snapshot,
          INGESTION_ANALYZE_PROMPT_VERSION,
        ),
      });
      const accounting = {
        projectId: file.projectId,
        operation: "ingestion.analyze",
        jobId: execution.jobId,
        connectionId: snapshot.connectionId,
        provider: snapshot.providerType,
        model: snapshot.providerModelId,
        configFingerprint: ingestionRouteFingerprint(
          snapshot,
          INGESTION_ANALYZE_PROMPT_VERSION,
        ),
        pricing: {
          inputCostMicrosPerMillion: snapshot.inputCostMicrosPerMillion,
          outputCostMicrosPerMillion: snapshot.outputCostMicrosPerMillion,
        },
        currency: snapshot.currency,
      };
      const callStarted = Date.now();
      let result: Awaited<ReturnType<typeof generateText>>;
      try {
        const model = deps.modelFactory
          ? deps.modelFactory(snapshot)
          : createAssistantLanguageModel(
              snapshot,
              createDbCredentialSource(deps.db, deps.ring),
              deps.fetchImpl,
            );
        result = await generateText({
          model,
          system: ANALYZE_SYSTEM_PROMPT,
          prompt: analysisUserMessage({
            fileName: file.fileName,
            targetKind: draft.targetKind,
            folders,
            excerpt: draft.markdown ?? tableExcerpt(draft),
            columns: draft.columns?.map((column) => column.name),
            sampleRows: draft.rows ?? undefined,
          }),
          abortSignal: execution.signal,
          maxOutputTokens: snapshot.maxOutputTokens
            ? Math.min(snapshot.maxOutputTokens, ANALYZE_MAX_OUTPUT_TOKENS)
            : ANALYZE_MAX_OUTPUT_TOKENS,
        });
      } catch (error) {
        if (execution.signal.aborted) throw error;
        const failure = classifyRunError(error);
        const reserved = reserveDiagnosticEvent("warn");
        await recordAiUsageSafely(
          deps.db,
          {
            ...accounting,
            usage: emptyUsage(Date.now() - callStarted),
            outcome: "provider_failure",
          },
          recordUsage,
        );
        const committed = await failFile(deps.db, {
          fileId: file.id,
          attemptCount: file.attemptCount,
          fromStatus: "extracting",
          failureKind: "provider",
          message: withReference(
            failure.message,
            reserved?.reference ?? null,
            500,
          ),
        });
        if (committed)
          emitDiagnostic({
            id: reserved?.id,
            event: "ingestion.analyze.failed",
            severity: "warn",
            message: `ingestion.analyze failed: ${failure.message}`,
            durationMs: Date.now() - started,
            outcome: "error",
            projectId: file.projectId,
            details: {
              fileId: file.id,
              failureKind: "provider",
              reference: reserved?.reference ?? null,
              error: summarizeError(error),
            },
          });
        return;
      }
      execution.signal.throwIfAborted();
      analysis = modelOutputFailure(result) ? null : parseAnalysis(result.text);
      await recordAiUsageSafely(
        deps.db,
        {
          ...accounting,
          usage: usageFromSdk(result.usage, Date.now() - callStarted),
          outcome: analysis ? "success" : "validation_failure",
        },
        recordUsage,
      );
      if (!analysis) {
        degradedAnalysis = true;
        warnings.push(
          "AI analysis returned an unusable answer; the parsed title was kept",
        );
      }
    }
    execution.signal.throwIfAborted();
    const folder =
      analysis && folders.includes(analysis.folder) ? analysis.folder : "";
    if (analysis && analysis.folder !== "" && folder === "")
      warnings.push(
        `AI analysis proposed the folder ${JSON.stringify(analysis.folder.slice(0, 80))}, which does not exist; the project root was kept`,
      );
    const columns =
      draft.targetKind === "table" && draft.columns && draft.rows
        ? inferColumnTypes(draft.columns, draft.rows)
        : undefined;
    const committed = await completeAnalysis(deps.db, {
      fileId: file.id,
      attemptCount: file.attemptCount,
      proposedTitle: analysis?.title ?? draft.proposedTitle,
      proposedFolderPath: folder,
      columns,
      linkQueries: analysis?.linkQueries ?? [],
      warnings,
    });
    if (!committed) return;
    if (degradedAnalysis)
      emitDiagnostic({
        event: "ingestion.analyze.degraded",
        severity: "warn",
        message: "AI analysis output was rejected; parsed metadata retained",
        outcome: "error",
        projectId: file.projectId,
        jobId: execution.jobId ?? undefined,
        details: { fileId: file.id, failureKind: "invalid_output" },
      });
    const queuedNext = await publishStage("ingestion.link", {
      fileId: file.id,
      projectId: file.projectId,
      contentDigest: file.contentDigest,
      baseAttemptCount: file.attemptCount,
    });
    emitDiagnostic({
      event: "ingestion.analyze.completed",
      ...(queuedNext ? {} : { severity: "warn" as const }),
      message: queuedNext
        ? "ingestion.analyze proposed title and placement"
        : "ingestion.analyze completed but could not queue linking; reconciliation will retry",
      durationMs: Date.now() - started,
      outcome: "ok",
      projectId: file.projectId,
      details: {
        fileId: file.id,
        model: snapshot?.providerModelId ?? null,
        usedModel: analysis !== null,
        folders: folders.length,
        queuedNext,
      },
    });
  };
}
