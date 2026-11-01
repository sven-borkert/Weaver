import { assertAuthorName } from "./frontmatter";
import { canonicalReviewers, MAX_REVIEWERS, type ReviewerRef } from "./review";

export type StoredFolderReviewDefaults = { reviewers: ReviewerRef[] };

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An unusable optional setting is absent; an empty list remains explicit. */
export function normalizeFolderReviewDefaults(
  value: unknown,
): StoredFolderReviewDefaults | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const raw = (value as Record<string, unknown>).reviewers;
  if (!Array.isArray(raw) || raw.length > MAX_REVIEWERS) return null;
  const refs: ReviewerRef[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return null;
    const { type, id, name } = entry as Record<string, unknown>;
    if (
      (type !== "user" && type !== "group") ||
      typeof id !== "string" ||
      !CANONICAL_UUID.test(id) ||
      typeof name !== "string"
    )
      return null;
    try {
      assertAuthorName(name);
    } catch {
      return null;
    }
    refs.push({ type, id, name });
  }
  return { reviewers: canonicalReviewers(refs) };
}

/** Defaults are keyed by whole folder paths; the empty key represents the document root. */
export function closestFolderReviewDefault(
  path: string[],
  defaults: Record<string, StoredFolderReviewDefaults>,
): { path: string[]; reviewers: ReviewerRef[] } | null {
  for (let length = path.length; length >= 0; length--) {
    const ancestor = path.slice(0, length);
    const key = ancestor.join("/");
    if (Object.hasOwn(defaults, key))
      return { path: ancestor, reviewers: defaults[key]!.reviewers };
  }
  return null;
}

export const MAX_FOLDER_REVIEW_DOCUMENTS = 1_000;
export const MAX_FOLDER_REVIEW_BYTES = 50 * 1024 * 1024;

export function folderReviewExceedsLimits(
  changedDocumentCount: number,
  rewrittenBytes: number,
): boolean {
  return (
    changedDocumentCount > MAX_FOLDER_REVIEW_DOCUMENTS ||
    rewrittenBytes > MAX_FOLDER_REVIEW_BYTES
  );
}
