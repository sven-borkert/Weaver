"use client";

import { FileCode2, FileText } from "lucide-react";
import { useMemo } from "react";
import { serializeDocumentBody } from "@weaver/core/editor/markdown";
import { Button } from "~/components/ui/button";
import type { DocumentSectionNavigation } from "~/lib/documents/section-navigation";
import type { MarkdownDocument } from "~/lib/documents/use-document-session";
import { renderDocumentContent } from "~/lib/editor/render";
import { useDocumentViewShortcuts } from "~/lib/editor/use-document-view-shortcuts";
import { useDocumentSourceView } from "~/lib/editor/use-document-source-view";
import { createDocumentImageMapping } from "./DocumentImageMapping";
import { createDocumentReferenceMapping } from "./DocumentReferenceMapping";
import { DocumentSectionStatus } from "./DocumentSectionStatus";
import { DocumentActionsMenu } from "./DocumentActionsMenu";
import { documentCodeBlockMapping } from "./DocumentCodeBlock";
import { DocumentHeader } from "./DocumentHeader";
import { DocumentSourceView } from "./DocumentSourceView";
import { useDocumentPresentation } from "./useDocumentPresentation";

export function DocumentViewer({
  projectId,
  document,
  sectionNavigation,
}: {
  projectId: string;
  document: MarkdownDocument;
  sectionNavigation?: DocumentSectionNavigation;
}) {
  const {
    articleRef,
    titleRef,
    referenceState,
    referenceStatus,
    sectionAnnouncement,
    sectionNavigationKey,
  } = useDocumentPresentation({ projectId, document, sectionNavigation });
  const { sourceOpen, setSourceOpen, sourceRef, sourceInputRef } =
    useDocumentSourceView({ articleRef, navigationKey: sectionNavigationKey });
  useDocumentViewShortcuts({
    articleRef,
    sourceRef,
    onToggleSource: () => setSourceOpen((open) => !open),
  });
  const nodeMapping = useMemo(
    () => ({
      ...createDocumentReferenceMapping(
        projectId,
        referenceState.targets ?? [],
        referenceStatus,
      ),
      ...createDocumentImageMapping(projectId, document.path),
      ...documentCodeBlockMapping,
    }),
    [document.path, projectId, referenceState.targets, referenceStatus],
  );
  const renderedContent = useMemo(
    () => renderDocumentContent(document.content.contentJson, nodeMapping),
    [document.content.contentJson, nodeMapping],
  );
  const sourceText = useMemo(
    () => serializeDocumentBody(document.content.contentJson),
    [document.content.contentJson],
  );
  return (
    <article ref={articleRef} className="document-prose w-full px-6 py-8">
      <DocumentSectionStatus
        announcement={sectionAnnouncement}
        navigationKey={sectionNavigationKey}
      />
      <DocumentHeader
        document={document}
        titleRef={titleRef}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              aria-label={
                sourceOpen ? "View formatted document" : "View Markdown source"
              }
              aria-pressed={sourceOpen}
              aria-keyshortcuts="Control+Alt+s Meta+Alt+s"
              title={`${sourceOpen ? "View formatted document" : "View Markdown source"} (Ctrl/Cmd+Alt+S)`}
              onClick={() => setSourceOpen((open) => !open)}
            >
              {sourceOpen ? (
                <FileText data-icon="inline-start" />
              ) : (
                <FileCode2 data-icon="inline-start" />
              )}
              {sourceOpen ? "Formatted" : "Source"}
            </Button>
            <DocumentActionsMenu
              projectId={projectId}
              document={document}
              baseCommitSha={document.baseCommitSha}
            />
          </>
        }
      />
      {referenceState.warning ? (
        <p
          role={referenceState.targets ? "status" : "alert"}
          className="border-info-border bg-info-bg text-info mb-4 rounded-[6px] border px-3 py-2 text-[12px]"
        >
          {referenceState.warning}
        </p>
      ) : null}
      <div hidden={sourceOpen} inert={sourceOpen}>
        {renderedContent}
      </div>
      <DocumentSourceView
        value={sourceText}
        readOnly
        open={sourceOpen}
        inputRef={sourceInputRef}
        regionRef={sourceRef}
      />
    </article>
  );
}
