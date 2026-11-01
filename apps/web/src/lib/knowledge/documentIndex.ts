export const DOCUMENT_INDEX_POLL_MS = 3_000;

type PollableDocumentIndex = {
  headCommitSha: string;
  lights: { keyword: string; semantic: string; graph: string };
  generations: ReadonlyArray<{ document: { status: string } | null }>;
};

/** Poll while indexing is in flight or the response predates the version on screen. */
export function documentIndexRefetchInterval(
  data: PollableDocumentIndex | undefined,
  currentSha: string,
): number | false {
  if (!data) return false;
  if (data.headCommitSha !== currentSha) return DOCUMENT_INDEX_POLL_MS;
  const { keyword, semantic, graph } = data.lights;
  if ([keyword, semantic, graph].includes("pending")) {
    return DOCUMENT_INDEX_POLL_MS;
  }
  const processing = data.generations.some(
    (generation) =>
      generation.document?.status === "pending" ||
      generation.document?.status === "processing",
  );
  return processing ? DOCUMENT_INDEX_POLL_MS : false;
}

export function indexedVersionLabel(
  indexedSha: string | null,
  headSha: string,
): string {
  if (!indexedSha) return "Not indexed";
  return `${indexedSha.slice(0, 7)} · ${indexedSha === headSha ? "current" : "older version"}`;
}
