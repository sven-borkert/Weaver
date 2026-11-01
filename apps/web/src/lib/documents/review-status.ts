export type ReviewStatus = "overdue" | "due-soon" | "ok";

const DUE_SOON_MS = 30 * 24 * 60 * 60 * 1000;
const NAMED_REVIEWERS = 3;

/** overdue: dueAt <= now; due-soon: within 30 days; else ok. */
export function reviewStatus(dueAt: Date, now: Date): ReviewStatus {
  const remaining = dueAt.getTime() - now.getTime();
  if (remaining <= 0) return "overdue";
  return remaining <= DUE_SOON_MS ? "due-soon" : "ok";
}

/** A never-reviewed document is due now, shown as due-soon like the review line. */
export function documentReviewStatus(
  review: { reviewDueAt: Date | null; lastReviewedAt: Date | null },
  now: Date,
): ReviewStatus | null {
  if (!review.reviewDueAt) return null;
  if (!review.lastReviewedAt) return "due-soon";
  return reviewStatus(review.reviewDueAt, now);
}

export function reviewerSummary(reviewers: { name: string }[]): string {
  if (reviewers.length === 0) return "Project owners";
  const names = reviewers.slice(0, NAMED_REVIEWERS).map((r) => r.name);
  const rest = reviewers.length - names.length;
  return rest > 0 ? `${names.join(", ")} and ${rest} more` : names.join(", ");
}

/** Folder segments of a document path joined for display; "—" at the project root. */
export function reviewFolderLabel(path: string): string {
  const folders = path.split("/").filter(Boolean).slice(0, -1);
  return folders.length > 0 ? folders.join(" / ") : "—";
}
