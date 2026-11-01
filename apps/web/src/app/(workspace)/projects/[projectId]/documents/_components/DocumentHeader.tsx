"use client";

import type { ReactNode, Ref } from "react";
import { useMounted } from "~/lib/use-mounted";
import { cn } from "~/lib/utils";
import type { RouterOutputs } from "~/trpc/react";
import { DocumentReviewLine } from "./DocumentReviewLine";

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function DocumentHeader({
  document,
  titleRef,
  titleControl,
  actions,
  className,
}: {
  document: RouterOutputs["document"]["get"];
  titleRef?: Ref<HTMLHeadingElement>;
  titleControl?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const mounted = useMounted();
  const stamp = (label: string, at: Date, by: { name: string } | null) => (
    <>
      {label}
      {mounted ? (
        <>
          {" "}
          <time dateTime={at.toISOString()}>
            {dateTimeFormatter.format(at)}
          </time>
        </>
      ) : null}{" "}
      by {by?.name ?? "unknown author"}
    </>
  );
  return (
    <header
      className={cn(
        "mb-8 flex flex-wrap items-start justify-between gap-4",
        className,
      )}
    >
      {/* A real basis lets the actions wrap below instead of squeezing the title. */}
      <div className="min-w-0 grow basis-48">
        <h1
          ref={titleRef}
          data-document-title="true"
          aria-label={titleControl ? document.title : undefined}
          tabIndex={-1}
          className="text-text m-0 text-[30px] leading-tight font-semibold break-words"
        >
          {titleControl ?? document.title}
        </h1>
        <p className="text-text-3 mt-2 mb-0 text-[12px]">
          {stamp("Created", document.createdAt, document.createdBy)} ·{" "}
          {stamp("Updated", document.updatedAt, document.updatedBy)}
        </p>
        <DocumentReviewLine review={document.review} />
      </div>
      <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
        {actions}
      </div>
    </header>
  );
}
