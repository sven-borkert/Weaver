import type { ActivityEntry } from "@weaver/core/dashboard/schema";
import Link from "next/link";
import { Badge } from "~/components/ui/badge";
import { ClientDateTime } from "~/components/ui/client-date";
import {
  activityAttribution,
  dashboardDestinationHref,
  workOutcomeLabel,
} from "~/lib/dashboard/presentation";

export function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const href = dashboardDestinationHref(entry.destination);
  const isContent = entry.category === "content_update";
  const label = isContent
    ? activityAttribution(entry.editorName, entry.isOwnChange)
    : entry.state
      ? workOutcomeLabel(entry.state)
      : "Result";
  return (
    <article className="border-line flex flex-col gap-1 border-b py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={href}
          className="text-text text-[13px] font-medium hover:underline"
        >
          {entry.title}
        </Link>
        <Badge
          variant={
            entry.state === "failed" || entry.state === "blocked"
              ? "destructive"
              : "secondary"
          }
        >
          {label}
        </Badge>
      </div>
      <div className="text-text-3 flex flex-wrap gap-x-2 text-[12px]">
        {entry.projectName ? <span>{entry.projectName}</span> : null}
        {entry.occurredAt ? (
          <ClientDateTime value={new Date(entry.occurredAt)} />
        ) : (
          <span>Time unavailable</span>
        )}
        {entry.currentReport ? (
          <Link
            className="text-brand-text hover:underline"
            href={dashboardDestinationHref(entry.currentReport)}
          >
            Current report
          </Link>
        ) : null}
      </div>
    </article>
  );
}
