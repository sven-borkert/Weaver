"use client";

import { Table2 } from "lucide-react";
import Link from "next/link";

import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "~/components/ui/hover-card";
import { useMounted } from "~/lib/use-mounted";
import type { RouterOutputs } from "~/trpc/react";

type ResolvedReference = RouterOutputs["document"]["resolveRefs"][number];

type DocumentReferenceProps = {
  projectId: string;
  targetType: "document" | "table";
  target: ResolvedReference;
  fallbackLabel: string | null;
};

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function DocumentReference({
  projectId,
  targetType,
  target,
  fallbackLabel,
}: DocumentReferenceProps) {
  const mounted = useMounted();
  const trimmedFallbackLabel = fallbackLabel?.trim();

  if (!target.exists || target.targetType !== targetType) {
    return (
      <span
        role="note"
        aria-label={`Broken ${targetType} reference`}
        className="border-danger-border bg-danger-bg text-danger inline-flex rounded-[4px] border px-[0.3em] line-through decoration-current/50"
      >
        {trimmedFallbackLabel?.length ? trimmedFallbackLabel : "Untitled"}
      </span>
    );
  }

  if (targetType === "table") {
    return (
      <HoverCard openDelay={250} closeDelay={100}>
        <HoverCardTrigger asChild>
          <Link
            href={`/projects/${projectId}/tables/${target.id}`}
            data-crossref-id={target.id}
            className="border-info-border bg-info-bg text-info hover:text-brand-hover focus-visible:ring-brand/50 inline-flex items-center gap-1 rounded-[4px] border px-[0.3em] no-underline outline-none focus-visible:ring-3"
          >
            <Table2 aria-hidden="true" className="size-3" />
            {target.title}
          </Link>
        </HoverCardTrigger>
        <HoverCardContent align="start" className="w-72">
          <div className="flex items-center gap-2">
            <Table2 aria-hidden="true" className="text-info size-4" />
            <p className="text-text m-0 text-[13px] font-semibold">
              {target.title}
            </p>
          </div>
          <p className="text-text-muted mt-0.5 mb-0 truncate text-[11px]">
            {target.path}
          </p>
          <p className="text-text-2 mt-2 mb-0 text-[12px] leading-5">
            No preview available.
          </p>
          {mounted ? (
            <p className="text-text-muted mt-2 mb-0 text-[11px]">
              Last edited{" "}
              <time dateTime={target.lastEditedAt.toISOString()}>
                {dateTimeFormatter.format(target.lastEditedAt)}
              </time>
            </p>
          ) : null}
        </HoverCardContent>
      </HoverCard>
    );
  }

  return (
    <HoverCard openDelay={250} closeDelay={100}>
      <HoverCardTrigger asChild>
        <Link
          href={`/projects/${projectId}/documents/${target.id}`}
          data-crossref-id={target.id}
          className="border-brand-border bg-brand-bg text-brand-text hover:text-brand-hover focus-visible:ring-brand/50 inline-flex rounded-[4px] border px-[0.3em] no-underline outline-none focus-visible:ring-3"
        >
          {target.title}
        </Link>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-72">
        <p className="text-text m-0 text-[13px] font-semibold">
          {target.title}
        </p>
        <p className="text-text-muted mt-0.5 mb-0 truncate text-[11px]">
          {target.path}
        </p>
        <p className="text-text-2 mt-2 mb-0 line-clamp-3 text-[12px] leading-5">
          {target.excerpt || "No preview available."}
        </p>
        {mounted ? (
          <p className="text-text-muted mt-2 mb-0 text-[11px]">
            Last edited{" "}
            <time dateTime={target.lastEditedAt.toISOString()}>
              {dateTimeFormatter.format(target.lastEditedAt)}
            </time>
          </p>
        ) : null}
      </HoverCardContent>
    </HoverCard>
  );
}
