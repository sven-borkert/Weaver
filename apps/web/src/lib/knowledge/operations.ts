import { queryErrorCode } from "~/lib/query-presentation";
export type KnowledgeRetryCursor = {
  generationId: string;
  documentId: string;
};

export type KnowledgeRetryPage = {
  retried: number;
  hasMore: boolean;
  nextCursor: KnowledgeRetryCursor | null;
};

type KnowledgeStatusState<
  T extends {
    buildingGeneration: object | null;
    readiness?: {
      keyword?: string;
      semantic?: string;
      graph?: string;
    };
  },
> = {
  data?: T;
  error?: unknown;
};

const KNOWLEDGE_ACCESS_ERROR_CODES = new Set([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
]);

export function knowledgeStatusLifecycle<
  T extends {
    buildingGeneration: object | null;
    readiness?: {
      keyword?: string;
      semantic?: string;
      graph?: string;
    };
  },
>(
  state: KnowledgeStatusState<T>,
): {
  accessError: boolean;
  snapshot: T | undefined;
  refetchInterval: 3_000 | false;
} {
  const accessError = isKnowledgeAccessError(state.error);
  const workInProgress =
    Boolean(state.data?.buildingGeneration) ||
    Object.values(state.data?.readiness ?? {}).includes("building");
  return {
    accessError,
    snapshot: accessError ? undefined : state.data,
    refetchInterval: !accessError && workInProgress ? 3_000 : false,
  };
}

export async function runFailedKnowledgeRetry(
  fetchPage: (
    cursor: KnowledgeRetryCursor | undefined,
  ) => Promise<KnowledgeRetryPage>,
): Promise<{ retried: number; outcome: "complete" | "stalled" }> {
  let cursor: KnowledgeRetryCursor | undefined;
  let retried = 0;
  const seenCursors = new Set<string>();

  while (true) {
    const page = await fetchPage(cursor);
    retried += page.retried;

    if (!page.hasMore) return { retried, outcome: "complete" };
    if (page.retried === 0 || !page.nextCursor) {
      return { retried, outcome: "stalled" };
    }

    const cursorKey = `${page.nextCursor.generationId}:${page.nextCursor.documentId}`;
    if (seenCursors.has(cursorKey)) {
      return { retried, outcome: "stalled" };
    }
    seenCursors.add(cursorKey);
    cursor = page.nextCursor;
  }
}

function isKnowledgeAccessError(error: unknown): boolean {
  return KNOWLEDGE_ACCESS_ERROR_CODES.has(queryErrorCode(error) ?? "");
}

export function outdatedExtractionMessage(
  outdated: number,
  total: number,
): string | null {
  if (outdated <= 0) return null;
  const verb = outdated === 1 ? "was" : "were";
  return `${outdated} of ${total} documents ${verb} extracted with an older model or prompt. Rebuild to re-extract all documents with the current model.`;
}
