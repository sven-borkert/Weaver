"use client";

import Link from "next/link";
import { ChevronRight, Loader2 } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { runStateCopy, type RunPhase } from "~/lib/assistant/runErrorCopy";
import { splitReference } from "~/lib/diagnosticReference";
import { cn } from "~/lib/utils";
import { api } from "~/trpc/react";

type RunStateStripProps = {
  status:
    "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
  hasText: boolean;
  awaitingExternalApproval?: boolean;
  queuedForMs: number;
  errorCode: string | null;
  errorMessage: string | null;
  retrying: boolean;
  attempt: number;
};

const SPINNING: RunPhase[] = ["queued", "waiting", "thinking", "cancelling"];

export function RunStateStrip(props: RunStateStripProps) {
  const me = api.account.me.useQuery(undefined, { staleTime: 60_000 });
  const isAdmin = me.data?.role === "Admin";
  const parsed = splitReference(props.errorMessage);
  const copy = runStateCopy(props);
  const phase = copy.phase;
  const label =
    props.status === "running" && props.awaitingExternalApproval
      ? "Waiting for external tool approval"
      : copy.label;
  // A retry attempt is worth surfacing even mid-stream, when the phase copy
  // itself goes quiet (label null) because the streamed text is already the
  // progress indicator.
  const showAttempt = props.attempt > 1 && phase !== "failed";
  if (!label && !showAttempt) return null;
  const tone =
    phase === "failed"
      ? "text-danger"
      : phase === "cancelled"
        ? "text-text-muted"
        : "text-text-2";
  return (
    <div className={cn("flex flex-col gap-1 text-[12px]", tone)} role="status">
      <span className="flex items-center gap-1.5">
        {SPINNING.includes(phase) && !props.awaitingExternalApproval ? (
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        ) : null}
        {label}
        {showAttempt ? (
          <span className="text-text-muted">
            · attempt {props.attempt} of 3
          </span>
        ) : null}
      </span>
      {phase === "failed" && props.errorMessage ? (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-[11px]">
            <ChevronRight
              className="size-3 group-data-[state=open]:rotate-90"
              aria-hidden="true"
            />
            Details
          </CollapsibleTrigger>
          <CollapsibleContent forceMount className="data-[state=closed]:hidden">
            <pre className="bg-subtle text-text-2 mt-1 rounded p-2 text-[11px] whitespace-pre-wrap">
              {parsed.text}
              {parsed.reference ? (
                <>
                  {" (ref "}
                  {isAdmin ? (
                    <Link
                      href={`/admin/diagnostics?ref=${parsed.reference}`}
                      className="underline"
                    >
                      {parsed.reference}
                    </Link>
                  ) : (
                    parsed.reference
                  )}
                  {")"}
                </>
              ) : null}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}
