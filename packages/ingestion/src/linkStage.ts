import type { PrismaClient } from "@weaver/db/client";
import {
  emitDiagnostic,
  reserveDiagnosticEvent,
} from "@weaver/core/diagnostics/writer";
import { withReference } from "@weaver/core/diagnostics/reference";
import { summarizeError } from "@weaver/core/diagnostics/errorSummary";
import {
  headingsOf,
  linkQueryFor,
  MAX_PROPOSED_LINKS,
  scoreLinkCandidates,
  type LinkCandidate,
} from "@weaver/core/ingestion/links";
import type { IngestionLinkRunner } from "@weaver/core/jobs/types";
import {
  claimFileForLinking,
  completeLinking,
  failFile,
} from "@weaver/core/services/ingestion";
import { loadLexicalDocuments } from "@weaver/core/services/searchLexical";

export const MAX_LINK_STAGE_QUERIES = 8;

export type LinkDraftInput = {
  proposedTitle: string;
  linkQueries: string[];
  markdown: string | null;
  columns: { name: string }[] | null;
};

function linkQueryInputsFor(
  draft: LinkDraftInput,
): { query: string; exactTitle: string }[] {
  const sources = [
    draft.proposedTitle,
    ...draft.linkQueries,
    ...(draft.markdown ? headingsOf(draft.markdown) : []),
    ...(draft.columns
      ? [
          draft.columns.map((column) => column.name).join(" "),
          ...draft.columns.map((column) => column.name),
        ]
      : []),
  ];
  const inputs: { query: string; exactTitle: string }[] = [];
  for (const source of sources) {
    const query = linkQueryFor(source);
    if (query && !inputs.some((input) => input.query === query))
      inputs.push({ query, exactTitle: source });
    if (inputs.length === MAX_LINK_STAGE_QUERIES) break;
  }
  return inputs;
}

/** Title first, then analysis phrases, then headings or column names; deduplicated and capped. */
export function linkQueriesFor(draft: LinkDraftInput): string[] {
  return linkQueryInputsFor(draft).map(({ query }) => query);
}

export type IngestionLinkRunnerDeps = {
  db: PrismaClient;
  searchDocuments?: typeof loadLexicalDocuments;
};

export function createIngestionLinkRunner(
  deps: IngestionLinkRunnerDeps,
): IngestionLinkRunner {
  const searchDocuments = deps.searchDocuments ?? loadLexicalDocuments;
  return async (payload, execution) => {
    execution.signal.throwIfAborted();
    const started = Date.now();
    const delivery =
      execution.jobId !== null && execution.retryCount !== null
        ? { jobId: execution.jobId, retryCount: execution.retryCount }
        : undefined;
    const file = await claimFileForLinking(deps.db, payload.fileId, {
      expectedProjectId: payload.projectId,
      expectedContentDigest: payload.contentDigest,
      baseAttemptCount: payload.baseAttemptCount,
      delivery,
    });
    if (!file) return;
    const queryInputs = linkQueryInputsFor(file.draft);
    const perQuery: LinkCandidate[][] = [];
    try {
      for (const { query } of queryInputs) {
        execution.signal.throwIfAborted();
        perQuery.push(
          await searchDocuments(
            deps.db,
            [file.projectId],
            query,
            MAX_PROPOSED_LINKS,
          ),
        );
      }
    } catch (error) {
      if (execution.signal.aborted) throw error;
      const reserved = reserveDiagnosticEvent("warn");
      const committed = await failFile(deps.db, {
        fileId: file.id,
        attemptCount: file.attemptCount,
        fromStatus: "linking",
        failureKind: "internal",
        message: withReference(
          "related-document search failed",
          reserved?.reference ?? null,
          500,
        ),
      });
      if (committed)
        emitDiagnostic({
          id: reserved?.id,
          event: "ingestion.link.failed",
          severity: "warn",
          message: "ingestion.link could not search project documents",
          durationMs: Date.now() - started,
          outcome: "error",
          projectId: file.projectId,
          details: {
            fileId: file.id,
            queries: queryInputs.length,
            reference: reserved?.reference ?? null,
            error: summarizeError(error),
          },
        });
      return;
    }
    const links = scoreLinkCandidates(
      perQuery,
      queryInputs.map(({ exactTitle }) => exactTitle),
    );
    const committed = await completeLinking(deps.db, {
      fileId: file.id,
      attemptCount: file.attemptCount,
      links,
    });
    if (!committed) return;
    emitDiagnostic({
      event: "ingestion.link.completed",
      message: `ingestion.link proposed ${links.length} related documents`,
      durationMs: Date.now() - started,
      outcome: "ok",
      projectId: file.projectId,
      details: {
        fileId: file.id,
        queries: queryInputs.length,
        links: links.length,
        kept: links.filter((link) => link.keep).length,
      },
    });
  };
}
