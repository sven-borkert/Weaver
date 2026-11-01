import { Loader2 } from "lucide-react";
import { notebookErrorMessage } from "@weaver/core/artifacts/notebookSchema";
import type { ArtifactNotebookListState } from "@weaver/core/services/artifacts";

const count = new Intl.NumberFormat("en-US");
const plural = (value: number, word: string) =>
  `${count.format(value)} ${word}${value === 1 ? "" : "s"}`;

export function notebookStatusPresentation(state: ArtifactNotebookListState): {
  label: string;
  tone: string;
  detail: string | null;
  busy: boolean;
} {
  switch (state.status) {
    case "unprepared":
      return {
        label: "Not prepared",
        tone: "bg-surface-2 text-text-2",
        detail: null,
        busy: false,
      };
    case "queued":
      return {
        label: "Waiting to prepare",
        tone: "bg-info-bg text-info",
        detail: null,
        busy: true,
      };
    case "running":
      return {
        label: "Preparing",
        tone: "bg-info-bg text-info",
        detail: null,
        busy: true,
      };
    case "ready": {
      const parts = [
        plural(state.pageCount ?? 0, "page"),
        plural(state.sectionCount ?? 0, "section"),
      ];
      if (state.emptySectionCount)
        parts.push(`${count.format(state.emptySectionCount)} empty`);
      if (state.unreadableSectionCount)
        parts.push(`${count.format(state.unreadableSectionCount)} unreadable`);
      return {
        label: "Ready",
        tone: "bg-approved-bg text-approved",
        detail: parts.join(" · "),
        busy: false,
      };
    }
    case "failed":
      return {
        label: "Preparation failed",
        tone: "bg-danger-bg text-danger",
        detail: notebookErrorMessage(state.error),
        busy: false,
      };
  }
}

/** Whether the Files list should keep polling for this notebook. */
export function notebookInProgress(state: ArtifactNotebookListState | null) {
  return state?.status === "queued" || state?.status === "running";
}

export function NotebookStatus({
  state,
}: {
  state: ArtifactNotebookListState;
}) {
  const { label, tone, detail, busy } = notebookStatusPresentation(state);
  return (
    <span className="mt-1 flex flex-col items-start gap-0.5">
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
      >
        {busy ? (
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        ) : null}
        {label}
      </span>
      {detail ? <span className="text-text-3 text-xs">{detail}</span> : null}
    </span>
  );
}
