import { createIsolatedNativeParser } from "./native/isolated";
import { createHash } from "node:crypto";
import type { LanguageModel } from "ai";
import type { IngestionFailureKind, PrismaClient } from "@weaver/db/client";
import { CoreError } from "@weaver/core/errors";
import {
  emitDiagnostic,
  reserveDiagnosticEvent,
} from "@weaver/core/diagnostics/writer";
import { withReference } from "@weaver/core/diagnostics/reference";
import { summarizeError } from "@weaver/core/diagnostics/errorSummary";
import { MAX_MARKDOWN_CHARS } from "@weaver/core/documents/limits";
import { readBlob } from "@weaver/core/ingestion/blobStore";
import { draftTableIssue } from "@weaver/core/ingestion/draftTable";
import {
  contentTypeMatches,
  normalizeMimeType,
} from "@weaver/core/ingestion/mimeTypes";
import { ingestionRouteSnapshot } from "@weaver/core/ingestion/route";
import type { IngestionSettings } from "@weaver/core/ingestion/settings";
import type { IngestionParseRunner } from "@weaver/core/jobs/types";
import type { EncryptionKeyRing } from "@weaver/core/security/encryption";
import {
  claimFileForParsing,
  completeParse,
  failFile,
  recordParseAttemptDetails,
  type CompleteParseDraft,
} from "@weaver/core/services/ingestion";
import { getIngestionSettings } from "@weaver/core/services/ingestionSettings";
import type { LlmModelSnapshot } from "@weaver/core/services/llmRoutes";
import { SPREADSHEET_TYPES, unsupportedMessage } from "./native/index";
import { createOcrClient } from "./ocr";
import {
  isParseFailure,
  type DocumentParser,
  type ParsedDocument,
  type ParseFailure,
} from "./parser";
import { parsersFor, parseWithFallback } from "./selectParser";
import { titleFromFileName } from "./title";
import { publishStage } from "./publish";

export type IngestionParseRunnerDeps = {
  db: PrismaClient;
  dataDir: string;
  ring: EncryptionKeyRing | null;
  maxOcrPages: number;
  maxFileBytes: number;
  fetchImpl?: typeof fetch;
  modelFactory?: (snapshot: LlmModelSnapshot) => LanguageModel;
  loadSettings?: () => Promise<IngestionSettings>;
};

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

/** Spreadsheets become table drafts; everything else becomes a document draft (plan decision 3). */
export function draftFromParsed(
  mimeType: string,
  parsed: ParsedDocument,
): CompleteParseDraft | ParseFailure {
  if (SPREADSHEET_TYPES.has(normalizeMimeType(mimeType))) {
    const table = parsed.tables[0];
    if (!table)
      return {
        failureKind: "validation",
        message: "the spreadsheet contains no data",
      };
    const columns = table.columns.map((name) => ({
      name,
      type: "text" as const,
    }));
    const issue = draftTableIssue(columns, table.rows);
    if (issue) return { failureKind: "validation", message: issue };
    return { targetKind: "table", columns, rows: table.rows };
  }
  if (parsed.markdown.trim().length === 0) {
    return {
      failureKind: "validation",
      message: "no text could be extracted from the file",
    };
  }
  if (parsed.markdown.length > MAX_MARKDOWN_CHARS) {
    return {
      failureKind: "validation",
      message: `parsed content exceeds ${MAX_MARKDOWN_CHARS} characters`,
    };
  }
  return { targetKind: "document", markdown: parsed.markdown };
}

export function createIngestionParseRunner(
  deps: IngestionParseRunnerDeps,
): IngestionParseRunner {
  const loadSettings =
    deps.loadSettings ?? (() => getIngestionSettings(deps.db));

  return async (payload, execution) => {
    execution.signal.throwIfAborted();
    const started = Date.now();
    const delivery =
      execution.jobId !== null && execution.retryCount !== null
        ? { jobId: execution.jobId, retryCount: execution.retryCount }
        : undefined;
    const file = await claimFileForParsing(deps.db, payload.fileId, {
      expectedProjectId: payload.projectId,
      expectedContentDigest: payload.contentDigest,
      baseAttemptCount: payload.baseAttemptCount,
      delivery,
    });
    if (!file) return;
    execution.signal.throwIfAborted();
    let adapter: DocumentParser | null = null;

    const fail = async (failure: {
      failureKind: IngestionFailureKind;
      message: string;
      error?: unknown;
    }): Promise<void> => {
      const reserved = reserveDiagnosticEvent("warn");
      const committed = await failFile(deps.db, {
        fileId: file.id,
        attemptCount: file.attemptCount,
        failureKind: failure.failureKind,
        message: withReference(
          failure.message,
          reserved?.reference ?? null,
          500,
        ),
      });
      if (!committed) return;
      const blocked = failure.failureKind === "configuration";
      emitDiagnostic({
        id: reserved?.id,
        event: blocked ? "ingestion.parse.blocked" : "ingestion.parse.failed",
        severity: "warn",
        message: `ingestion.parse ${blocked ? "blocked" : "failed"}: ${failure.message}`,
        durationMs: Date.now() - started,
        outcome: blocked ? "blocked" : "error",
        projectId: file.projectId,
        details: {
          fileId: file.id,
          failureKind: failure.failureKind,
          adapter: adapter?.id ?? null,
          reference: reserved?.reference ?? null,
          ...(failure.error === undefined
            ? {}
            : { error: summarizeError(failure.error) }),
        },
      });
    };

    if (file.byteSize > deps.maxFileBytes) {
      await fail({
        failureKind: "validation",
        message: "the uploaded original exceeds the configured upload limit",
      });
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await readBlob(
        deps.dataDir,
        file.projectId,
        file.contentDigest,
        deps.maxFileBytes,
      );
    } catch (error) {
      if (error instanceof RangeError) {
        await fail({
          failureKind: "validation",
          message: "the uploaded original exceeds parser input limits",
          error,
        });
        return;
      }
      if (!hasCode(error, "ENOENT")) throw error;
      await fail({
        failureKind: "source_missing",
        message: "the uploaded original is no longer on disk",
        error,
      });
      return;
    }
    execution.signal.throwIfAborted();
    if (
      createHash("sha256").update(bytes).digest("hex") !== file.contentDigest
    ) {
      await fail({
        failureKind: "validation",
        message: "the uploaded original failed its digest check",
      });
      return;
    }
    if (!contentTypeMatches(file.mimeType, bytes)) {
      await fail({
        failureKind: "validation",
        message:
          "the uploaded original does not match its declared content type",
      });
      return;
    }

    const settings = await loadSettings();
    const ocr = createOcrClient({
      db: deps.db,
      ring: deps.ring,
      fetchImpl: deps.fetchImpl,
      modelFactory: deps.modelFactory,
    });
    const native = createIsolatedNativeParser({
      ocr,
      maxOcrPages: deps.maxOcrPages,
    });
    const parsers = parsersFor(settings, native, deps.fetchImpl);
    const selected = await parseWithFallback(
      parsers,
      {
        fileId: file.id,
        projectId: file.projectId,
        jobId: execution.jobId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        bytes,
        onRouteResolved: async (snapshot) => {
          await recordParseAttemptDetails(deps.db, {
            fileId: file.id,
            attemptCount: file.attemptCount,
            routeSnapshot: ingestionRouteSnapshot(snapshot),
          });
        },
      },
      execution.signal,
      async (parser) => {
        adapter = parser;
        await recordParseAttemptDetails(deps.db, {
          fileId: file.id,
          attemptCount: file.attemptCount,
          parser: { id: parser.id, version: parser.version },
        });
      },
    );
    if (!selected) {
      await fail({
        failureKind: "parser",
        message: unsupportedMessage(
          file.mimeType,
          settings.doclingBaseUrl !== null,
        ),
      });
      return;
    }
    if (isParseFailure(selected.outcome)) {
      await fail(selected.outcome);
      return;
    }
    execution.signal.throwIfAborted();
    const draft = draftFromParsed(file.mimeType, selected.outcome);
    if ("failureKind" in draft) {
      await fail(draft);
      return;
    }

    let committed: boolean;
    try {
      committed = await completeParse(deps.db, {
        fileId: file.id,
        attemptCount: file.attemptCount,
        parserAdapterId: selected.parser.id,
        parserVersion: selected.parser.version,
        proposedTitle: titleFromFileName(file.fileName),
        warnings: selected.outcome.warnings
          .slice(0, 100)
          .map((warning) => warning.slice(0, 500)),
        draft,
      });
    } catch (error) {
      if (!(error instanceof CoreError) || error.code !== "BAD_REQUEST")
        throw error;
      await fail({
        failureKind: "internal",
        message: "parser produced an invalid draft",
        error,
      });
      return;
    }
    if (!committed) return;
    // A wiki file stops at ready; only the wiki tick accepts it.
    const queuedNext =
      file.origin === "wiki" ||
      (await publishStage("ingestion.analyze", {
        fileId: file.id,
        projectId: file.projectId,
        contentDigest: file.contentDigest,
        baseAttemptCount: file.attemptCount,
      }));
    emitDiagnostic({
      event: "ingestion.parse.completed",
      ...(queuedNext ? {} : { severity: "warn" as const }),
      message: queuedNext
        ? "ingestion.parse produced a draft"
        : "ingestion.parse produced a draft but could not queue analysis; reconciliation will retry",
      durationMs: Date.now() - started,
      outcome: "ok",
      projectId: file.projectId,
      details: {
        fileId: file.id,
        adapter: selected.parser.id,
        bytes: bytes.byteLength,
        targetKind: draft.targetKind,
        pageCount: selected.outcome.pageCount ?? null,
        ocrPages: selected.outcome.ocrPages ?? 0,
        queuedNext,
      },
    });
  };
}
