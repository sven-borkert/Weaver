"use client";

import type { RenderMappings } from "~/lib/editor/render";
import {
  documentReferenceKey,
  indexResolvedDocumentReferences,
} from "~/lib/documents/references";
import type { RouterOutputs } from "~/trpc/react";
import { DocumentReference } from "./DocumentReference";
import { withMermaidRendererMapping } from "./MermaidRenderer";

type ResolvedReference = RouterOutputs["document"]["resolveRefs"][number];
export type DocumentReferenceResolutionStatus = "pending" | "settled" | "error";

function PendingDocumentReference({
  targetType,
  fallbackLabel,
}: {
  targetType: "document" | "table";
  fallbackLabel: string | null;
}) {
  const trimmedFallbackLabel = fallbackLabel?.trim();

  return (
    <span
      role="status"
      aria-label={`Loading ${targetType} reference`}
      className="border-line bg-subtle text-text-2 inline-flex rounded-[4px] border px-[0.3em]"
    >
      {trimmedFallbackLabel?.length ? trimmedFallbackLabel : "Untitled"}
    </span>
  );
}

export function ResolvedDocumentReference({
  projectId,
  targetId,
  targetType,
  fallbackLabel,
  target,
  status,
}: {
  projectId: string;
  targetId: string;
  targetType: "document" | "table";
  fallbackLabel: string | null;
  target?: ResolvedReference;
  status: DocumentReferenceResolutionStatus;
}) {
  if (!target && status === "pending") {
    return (
      <PendingDocumentReference
        targetType={targetType}
        fallbackLabel={fallbackLabel}
      />
    );
  }

  return (
    <DocumentReference
      projectId={projectId}
      targetType={targetType}
      target={target ?? { id: targetId, exists: false as const }}
      fallbackLabel={fallbackLabel}
    />
  );
}

export function createDocumentReferenceMapping(
  projectId: string,
  targets: ResolvedReference[],
  status: DocumentReferenceResolutionStatus,
): RenderMappings {
  const resolvedByKey = indexResolvedDocumentReferences(targets);

  return withMermaidRendererMapping({
    crossref: ({ node }) => {
      const targetId =
        typeof node.attrs.targetId === "string" ? node.attrs.targetId : "";
      const targetType =
        node.attrs.targetType === "table" ? "table" : "document";
      const target = resolvedByKey.get(
        documentReferenceKey(targetType, targetId),
      );
      const fallbackLabel =
        typeof node.attrs.label === "string" ? node.attrs.label : null;

      return (
        <ResolvedDocumentReference
          projectId={projectId}
          targetId={targetId}
          targetType={targetType}
          target={target}
          fallbackLabel={fallbackLabel}
          status={status}
        />
      );
    },
  });
}
