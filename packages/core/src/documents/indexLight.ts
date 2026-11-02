export type IndexLight =
  "ready" | "failed" | "pending" | "unavailable" | "skipped";

export const AI_INDEXING_SKIPPED_SUMMARY = "AI indexing skipped (source page)";

export type DocumentIndexLights = {
  keyword: IndexLight;
  semantic: IndexLight;
  graph: IndexLight;
  summary: string | null;
};

export type IndexStateRow = {
  headCommitSha: string;
  keywordStatus: string | null;
  keywordTargetSha: string | null;
  keywordIndexedSha: string | null;
  keywordFailureSummary: string | null;
  generationStatus: string | null;
  generationTargetSha: string | null;
  generationFingerprint: string | null;
  semanticIndexedSha: string | null;
  graphIndexedSha: string | null;
  generationFailureSummary: string | null;
};

const FAILED_STATUSES = new Set(["failed", "blocked_configuration"]);

function keywordLight(row: IndexStateRow): IndexLight {
  if (
    row.keywordStatus === "ready" &&
    row.keywordTargetSha === row.headCommitSha &&
    row.keywordIndexedSha === row.headCommitSha
  )
    return "ready";
  if (
    row.keywordStatus &&
    FAILED_STATUSES.has(row.keywordStatus) &&
    row.keywordTargetSha === row.headCommitSha
  )
    return "failed";
  return "pending";
}

function aiLight(
  row: IndexStateRow,
  generation: { configFingerprint: string } | null,
  indexedSha: string | null,
  coveredByBuild: boolean,
): IndexLight {
  if (!generation) return "unavailable";
  const current =
    row.generationTargetSha === row.headCommitSha &&
    row.generationFingerprint === generation.configFingerprint;
  if (current && indexedSha === row.headCommitSha) return "ready";
  if (
    current &&
    row.generationStatus === "blocked_configuration" &&
    coveredByBuild
  )
    return "pending";
  if (
    current &&
    row.generationStatus &&
    FAILED_STATUSES.has(row.generationStatus)
  )
    return "failed";
  return "pending";
}

export function documentIndexLights(
  row: IndexStateRow,
  generation: { configFingerprint: string } | null,
  options: { coveredByBuild?: boolean; aiExempt?: boolean } = {},
): DocumentIndexLights {
  const coveredByBuild = options.coveredByBuild === true;
  const keyword = keywordLight(row);
  if (options.aiExempt)
    return {
      keyword,
      semantic: "skipped",
      graph: "skipped",
      summary:
        keyword === "failed"
          ? (row.keywordFailureSummary ?? null)
          : AI_INDEXING_SKIPPED_SUMMARY,
    };
  const semantic = aiLight(
    row,
    generation,
    row.semanticIndexedSha,
    coveredByBuild,
  );
  const graph = aiLight(row, generation, row.graphIndexedSha, coveredByBuild);
  const summary =
    keyword === "failed"
      ? row.keywordFailureSummary
      : semantic === "failed" || graph === "failed"
        ? row.generationFailureSummary
        : null;
  return { keyword, semantic, graph, summary: summary ?? null };
}

export function indexLightLabel(light: IndexLight): string {
  if (light === "unavailable") return "not configured";
  return light;
}

export function indexLightsDescription(lights: DocumentIndexLights): string {
  return `Index: keyword ${indexLightLabel(lights.keyword)}, semantic ${indexLightLabel(lights.semantic)}, graph ${indexLightLabel(lights.graph)}`;
}
