import type { DraftColumnType } from "@weaver/core/ingestion/draftTable";

export const COLUMN_TYPE_LABELS: Record<DraftColumnType, string> = {
  text: "Text",
  number: "Number",
  boolean: "Yes / no",
  date: "Date",
};

export function confidenceLabel(confidence: number): "High" | "Medium" | "Low" {
  if (confidence >= 0.8) return "High";
  if (confidence >= 0.6) return "Medium";
  return "Low";
}

export function resolveFolderValue(folders: string[], proposed: string) {
  if (proposed === "") return { value: [], missing: false };
  if (folders.includes(proposed)) {
    return { value: proposed.split("/"), missing: false };
  }
  return { value: [], missing: true };
}

export function reviewDestination(
  projectId: string,
  targetKind: "document" | "table",
  resourceId: string,
) {
  return targetKind === "document"
    ? `/projects/${projectId}/documents/${resourceId}`
    : `/projects/${projectId}/tables/${resourceId}`;
}

export function shouldSaveBeforeAccept(
  status: "ready" | "accepting",
  isDirty: boolean,
  folderWasNormalized: boolean,
) {
  return status === "ready" && (isDirty || folderWasNormalized);
}

// Accept names the revision the reviewer saw: the one on screen, or the one
// their own save just produced — never whatever is latest on the server.
export async function acceptReviewedDraft<T>({
  status,
  isDirty,
  folderWasNormalized,
  reviewedRevision,
  update,
  updatePayload,
  accept,
}: {
  status: "ready" | "accepting";
  isDirty: boolean;
  folderWasNormalized: boolean;
  reviewedRevision: number;
  update: (payload: T) => Promise<{ draft: { revision: number } | null }>;
  updatePayload: T;
  accept: (expectedRevision: number) => void;
}) {
  if (!shouldSaveBeforeAccept(status, isDirty, folderWasNormalized))
    return accept(reviewedRevision);
  const saved = await update(updatePayload);
  accept(saved.draft?.revision ?? reviewedRevision);
}

type LinkChoice = { documentId: string; keep: boolean };
export function linksForDraft(
  targetKind: "document" | "table",
  edited: LinkChoice[],
  stored: LinkChoice[],
) {
  return targetKind === "document" ? edited : stored;
}

export function rejectDialogState(pending: boolean) {
  return { disabled: pending, label: pending ? "Rejecting…" : "Reject draft" };
}
