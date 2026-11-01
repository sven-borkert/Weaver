"use client";

import { CircleAlert, CircleCheck, Clock, type LucideIcon } from "lucide-react";
import { useState } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import {
  documentReviewStatus,
  type ReviewStatus,
} from "~/lib/documents/review-status";
import type { DocumentItem } from "~/lib/documents/explorer";
import { useMounted } from "~/lib/use-mounted";
import { cn } from "~/lib/utils";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
});

const STATUS: Record<
  ReviewStatus,
  { Icon: LucideIcon; className: string; label: string }
> = {
  ok: {
    Icon: CircleCheck,
    className: "text-approved",
    label: "Reviewed",
  },
  "due-soon": {
    Icon: Clock,
    className: "text-review",
    label: "Review due soon",
  },
  overdue: {
    Icon: CircleAlert,
    className: "text-danger",
    label: "Review overdue",
  },
};

export function ReviewStatusIcon({
  review,
}: {
  review: Pick<DocumentItem, "reviewDueAt" | "lastReviewedAt">;
}) {
  const mounted = useMounted();
  const [now] = useState(() => new Date());
  if (!mounted || !review.reviewDueAt) return null;
  const status = documentReviewStatus(review, now);
  if (!status) return null;
  const { Icon, className, label } = STATUS[status];
  const dueAt = review.reviewDueAt;
  const description = !review.lastReviewedAt
    ? "Not reviewed yet · Review due now"
    : `${label} · ${status === "ok" ? "next review" : "due"} ${dateFormatter.format(dueAt)}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={description}
          data-review-status={status}
          className={cn("inline-flex shrink-0 items-center", className)}
        >
          <Icon className="size-3.5" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-[12px]">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}
