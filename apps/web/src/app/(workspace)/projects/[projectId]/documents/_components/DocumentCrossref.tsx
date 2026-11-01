"use client";

import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from "@tiptap/react";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Crossref } from "@weaver/core/editor/crossref";
import {
  documentReferenceKey,
  indexResolvedDocumentReferences,
} from "~/lib/documents/references";
import type { RouterOutputs } from "~/trpc/react";
import {
  ResolvedDocumentReference,
  type DocumentReferenceResolutionStatus,
} from "./DocumentReferenceMapping";

type ResolvedReference = RouterOutputs["document"]["resolveRefs"][number];
const ReferenceContext = createContext<{
  projectId: string;
  targets: Map<string, ResolvedReference>;
  status: DocumentReferenceResolutionStatus;
}>({ projectId: "", targets: new Map(), status: "pending" });

export function DocumentReferenceProvider({
  projectId,
  targets,
  status,
  children,
}: {
  projectId: string;
  targets: ResolvedReference[];
  status: DocumentReferenceResolutionStatus;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({
      projectId,
      targets: indexResolvedDocumentReferences(targets),
      status,
    }),
    [projectId, targets, status],
  );
  return (
    <ReferenceContext.Provider value={value}>
      {children}
    </ReferenceContext.Provider>
  );
}

export function DocumentCrossrefNodeView({
  node,
}: Pick<ReactNodeViewProps, "node">) {
  const { projectId, targets, status } = useContext(ReferenceContext);
  const targetId =
    typeof node.attrs.targetId === "string" ? node.attrs.targetId : "";
  const targetType = node.attrs.targetType === "table" ? "table" : "document";
  return (
    <NodeViewWrapper as="span" contentEditable={false}>
      <ResolvedDocumentReference
        projectId={projectId}
        targetId={targetId}
        targetType={targetType}
        fallbackLabel={
          typeof node.attrs.label === "string" ? node.attrs.label : null
        }
        target={targets.get(documentReferenceKey(targetType, targetId))}
        status={status}
      />
    </NodeViewWrapper>
  );
}

export const DocumentCrossref = Crossref.extend({
  addNodeView() {
    return ReactNodeViewRenderer(DocumentCrossrefNodeView);
  },
});
