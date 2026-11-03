import type { CitationCard } from "@weaver/core/services/assistantCitations";

export type SaveAsPageSource = {
  kind: "document" | "table";
  id: string;
  label: string;
  /** Another project's resource cannot be a source here; it stays unchecked and says why. */
  inTargetProject: boolean;
  checked: boolean;
  warning: string | null;
};

export type SaveAsPagePrefill = {
  title: string;
  /** Empty when no default applies; the page then goes to the project root. */
  folderPath: string[];
  body: string;
  type: "synthesis";
  sources: SaveAsPageSource[];
};

export const SAVE_AS_PAGE_TITLE_MAX = 200;
const OTHER_PROJECT_WARNING =
  "Belongs to another project, so it is not saved as a source of this page.";

/** The first heading, else the first non-empty line, as plain text. */
export function titleFromAnswer(text: string): string {
  const line =
    text
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.length > 0) ?? "";
  const plain = line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*>\d.)\s]+/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const title = plain.slice(0, SAVE_AS_PAGE_TITLE_MAX).trim();
  return title.length > 0 ? title : "Assistant answer";
}

/** Only readable document and table citations can be sources; one entry per resource. */
export function sourcesFromCitations(
  citations: readonly Pick<
    CitationCard,
    "kind" | "projectId" | "resourceId" | "access" | "label"
  >[],
  targetProjectId: string,
): SaveAsPageSource[] {
  const seen = new Set<string>();
  const out: SaveAsPageSource[] = [];
  for (const citation of citations) {
    if (citation.access !== "ok") continue;
    if (citation.kind !== "document" && citation.kind !== "table") continue;
    const key = `${citation.kind}:${citation.resourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const inTargetProject = citation.projectId === targetProjectId;
    out.push({
      kind: citation.kind,
      id: citation.resourceId,
      label: citation.label ?? citation.resourceId,
      inTargetProject,
      checked: inTargetProject,
      warning: inTargetProject ? null : OTHER_PROJECT_WARNING,
    });
  }
  return out;
}

/** `wikiFolderPath` is the recorded wiki anchor when the wiki is enabled, else null (no default). */
export function buildSaveAsPagePrefill(input: {
  answerText: string;
  citations: readonly Pick<
    CitationCard,
    "kind" | "projectId" | "resourceId" | "access" | "label"
  >[];
  targetProjectId: string;
  wikiFolderPath: string[] | null;
}): SaveAsPagePrefill {
  return {
    title: titleFromAnswer(input.answerText),
    folderPath: input.wikiFolderPath ?? [],
    body: input.answerText,
    type: "synthesis",
    sources: sourcesFromCitations(input.citations, input.targetProjectId),
  };
}

/** The `properties` of the create call: only checked sources that belong to the target project. */
export function savePropertiesFor(
  type: "synthesis",
  sources: readonly SaveAsPageSource[],
) {
  const kept = sources
    .filter((source) => source.checked && source.inTargetProject)
    .map((source) => ({ kind: source.kind, id: source.id }));
  return { type, ...(kept.length > 0 ? { sources: kept } : {}) };
}

/** Slash-separated folder text from the dialog back to path segments. */
export function parseFolderInput(text: string): string[] {
  return text
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}
