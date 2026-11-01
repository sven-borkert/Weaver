export const REVIEW_MONTHS_MIN = 1;
export const REVIEW_MONTHS_MAX = 120;
export const REVIEW_MONTHS_DEFAULT = 12;
export const MAX_REVIEWERS = 50;

/** A project member or a reviewer group; `name` is the name at write time. */
export type ReviewerRef = { type: "user" | "group"; id: string; name: string };

export type DocumentReview = {
  reviewers: ReviewerRef[];
  everyMonths: number;
  since: string;
  lastReviewed: string | null;
  reviewedBy: { id: string | null; name: string } | null;
};

/** Sorted by type then id (code-unit order, locale-independent), first entry of a duplicate wins. */
export function canonicalReviewers(
  refs: readonly ReviewerRef[],
): ReviewerRef[] {
  const seen = new Set<string>();
  return refs
    .filter((ref) => {
      const key = `${ref.type}:${ref.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) =>
      a.type !== b.type
        ? a.type < b.type
          ? -1
          : 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
    );
}

/** Calendar months in UTC; the day is clamped to the end of a shorter month. */
export function addMonthsUtc(timestamp: string, months: number): Date {
  const from = new Date(timestamp);
  const target = new Date(from);
  target.setUTCDate(1);
  target.setUTCMonth(from.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(from.getUTCDate(), lastDay));
  return target;
}

/** A never-reviewed document is due as soon as its clock starts. */
export function reviewDueAt(review: DocumentReview): Date {
  return review.lastReviewed
    ? addMonthsUtc(review.lastReviewed, review.everyMonths)
    : new Date(review.since);
}
