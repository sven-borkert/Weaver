"use client";

import { useState } from "react";
import { reviewStatus, reviewerSummary } from "~/lib/documents/review-status";
import { useMounted } from "~/lib/use-mounted";
import { cn } from "~/lib/utils";
import type { RouterOutputs } from "~/trpc/react";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
});

type Review = NonNullable<RouterOutputs["document"]["get"]["review"]>;

export function DocumentReviewLine({ review }: { review: Review | null }) {
  const mounted = useMounted();
  const [now] = useState(() => new Date());
  if (!review) return null;
  const neverReviewed = review.lastReviewedAt === null;
  const status = !mounted
    ? "ok"
    : neverReviewed
      ? "due-soon"
      : reviewStatus(review.dueAt, now);
  const date = (at: Date) =>
    mounted ? (
      <>
        {" "}
        <time dateTime={at.toISOString()}>{dateFormatter.format(at)}</time>
      </>
    ) : null;
  return (
    <p className="text-text-3 mt-1 mb-0 text-[12px]">
      Reviewers: {reviewerSummary(review.reviewers)} ·{" "}
      {review.lastReviewedAt ? (
        <>
          Last reviewed{date(review.lastReviewedAt)}
          {review.reviewedBy ? ` by ${review.reviewedBy.name}` : null}
        </>
      ) : (
        "Not reviewed yet"
      )}{" "}
      ·{" "}
      <span
        className={cn(
          status === "overdue" && "text-danger font-medium",
          status === "due-soon" && "text-review",
        )}
      >
        {neverReviewed ? (
          "Review due now"
        ) : (
          <>
            {status === "overdue" ? "Review overdue since" : "Next review due"}
            {date(review.dueAt)}
          </>
        )}
      </span>
    </p>
  );
}
