import type { BackgroundWorkItem } from "@weaver/core/jobs/backgroundWorkSchema";
import { ExternalLink } from "lucide-react";
import Link from "next/link";

import { Badge } from "~/components/ui/badge";
import { ClientDateTime } from "~/components/ui/client-date";
import { TableCell, TableRow } from "~/components/ui/table";
import { backgroundWorkHref } from "~/lib/background-work/destination";
import {
  WORK_KIND_LABELS,
  workStatusLabel,
} from "~/lib/background-work/presentation";
import { cn } from "~/lib/utils";

function stateVariant(state: BackgroundWorkItem["state"]) {
  if (state === "failed" || state === "blocked") return "destructive" as const;
  if (state === "succeeded") return "secondary" as const;
  return "outline" as const;
}

export function BackgroundWorkRow({
  item,
  compact = false,
  table = false,
  onNavigate,
}: {
  item: BackgroundWorkItem;
  compact?: boolean;
  table?: boolean;
  onNavigate?: (href: string) => void;
}) {
  const when = item.finishedAt ?? item.startedAt ?? item.createdAt;
  const status = workStatusLabel(item);
  const href = backgroundWorkHref(item.destination);
  const navigate = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (
      !onNavigate ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    onNavigate(href);
  };
  const openLink = (
    <Link
      href={href}
      onClick={navigate}
      aria-label={`Open ${item.title}`}
      className="text-text-3 hover:text-text inline-flex shrink-0 p-1"
    >
      <ExternalLink className="size-3.5" aria-hidden="true" />
    </Link>
  );
  if (table) {
    return (
      <TableRow>
        <TableCell className="min-w-60">
          <div className="flex items-center gap-2">
            {item.unseen ? (
              <span className="bg-brand size-1.5 shrink-0 rounded-full">
                <span className="sr-only">Unseen result</span>
              </span>
            ) : null}
            <Link
              href={href}
              onClick={navigate}
              className="text-text font-medium hover:underline"
            >
              {item.title}
            </Link>
          </div>
          <span className="text-text-3 text-[12px]">
            {WORK_KIND_LABELS[item.kind]}
          </span>
        </TableCell>
        <TableCell>{item.projectName ?? "—"}</TableCell>
        <TableCell>
          <Badge variant={stateVariant(item.state)}>{status}</Badge>
          {item.errorCode ? (
            <span
              className="text-danger mt-1 line-clamp-2 block text-[12px]"
              title={item.errorMessage ?? undefined}
            >
              {item.errorMessage ??
                "This work did not finish. Open its source for details."}
            </span>
          ) : null}
        </TableCell>
        <TableCell>
          {item.startedAt ? (
            <ClientDateTime value={new Date(item.startedAt)} />
          ) : (
            "—"
          )}
        </TableCell>
        <TableCell>
          {item.finishedAt ? (
            <ClientDateTime value={new Date(item.finishedAt)} />
          ) : (
            "—"
          )}
        </TableCell>
        <TableCell>{openLink}</TableCell>
      </TableRow>
    );
  }
  return (
    <div
      className={cn(
        "border-line flex min-w-0 items-start gap-3 border-b py-3 last:border-b-0",
        compact && "py-2.5",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {item.unseen ? (
            <span className="bg-brand size-1.5 shrink-0 rounded-full">
              <span className="sr-only">Unseen result</span>
            </span>
          ) : null}
          <Link
            href={href}
            onClick={navigate}
            className="text-text max-w-full min-w-0 truncate text-[13px] font-medium hover:underline"
          >
            {item.title}
          </Link>
          <Badge variant={stateVariant(item.state)}>{status}</Badge>
        </div>
        <div className="text-text-3 mt-1 flex min-w-0 flex-wrap gap-x-2 text-[12px] [&>span]:max-w-full [&>span]:truncate">
          <span>{WORK_KIND_LABELS[item.kind]}</span>
          {item.projectName ? <span>{item.projectName}</span> : null}
          <span>
            {item.finishedAt
              ? "Finished"
              : item.startedAt
                ? "Started"
                : "Queued"}
          </span>
          <ClientDateTime value={new Date(when)} />
          {item.progress ? (
            <span>
              {item.progress.ready}/{item.progress.total} ready
              {item.progress.failed ? ` · ${item.progress.failed} failed` : ""}
            </span>
          ) : null}
        </div>
        {item.errorCode ? (
          <p
            className="text-danger mt-1 line-clamp-2 text-[12px]"
            title={item.errorMessage ?? undefined}
          >
            {item.errorMessage ??
              "This work did not finish. Open its source for details."}
          </p>
        ) : null}
      </div>
      {openLink}
    </div>
  );
}
