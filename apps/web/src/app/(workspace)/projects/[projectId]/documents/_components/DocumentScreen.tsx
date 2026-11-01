"use client";

import type { Editor } from "@tiptap/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { Button } from "~/components/ui/button";
import {
  consumeContextDrawerCloseFocus,
  DEFAULT_CONTEXT_DRAWER_CLOSE_FOCUS,
  requestSelectionCloseFocus,
  type ContextDrawerCloseFocusPolicy,
} from "~/lib/documents/context-drawer-close-focus";
import {
  readPanelPreference,
  writePanelPreference,
} from "~/lib/documents/panel-state";
import { collectDocumentReferences } from "~/lib/documents/references";
import type { DocumentSectionNavigation } from "~/lib/documents/section-navigation";
import {
  isMarkdownDocument,
  isPythonDocument,
  type MarkdownDocument,
  type PythonDocument,
} from "~/lib/documents/use-document-session";
import {
  dataUnlessAccessError,
  resolveQueryPresentation,
} from "~/lib/query-presentation";
import { projectRoleAtLeast } from "@weaver/core/roles";
import {
  shouldProceedWithNavigation,
  UNSAVED_CHANGES_CONFIRMATION,
} from "~/lib/use-unsaved-changes-guard";
import { api } from "~/trpc/react";
import {
  WorkspaceError,
  WorkspaceLoading,
  WorkspaceNotFound,
} from "./DocumentStates";
import { ContextRail, type ContextTab } from "./ContextRail";
import { DocumentDiff } from "./DocumentDiff";
import { DocumentEditor } from "./DocumentEditor";
import {
  DocumentHistoryPanel,
  type DocumentHistoryPagination,
} from "./DocumentHistoryPanel";
import { DocumentIndexPanel } from "./DocumentIndexPanel";
import { DocumentLinksPanel } from "./DocumentLinksPanel";
import { DocumentOutlinePanel } from "./DocumentOutlinePanel";
import { DocumentRenderBoundary } from "./DocumentRenderBoundary";
import { DocumentViewer } from "./DocumentViewer";
import { DocumentsWorkspace } from "./DocumentsWorkspace";
import { MaintainedByTaskBanner } from "./MaintainedByTaskBanner";
import { PythonDocumentEditor } from "./PythonDocumentEditor";
import { PythonOutlinePanel } from "./PythonOutlinePanel";

type DocumentMode = "document" | "diff";

const emptyHistoryPagination: DocumentHistoryPagination = { entries: [] };

export function DocumentScreen({
  projectId,
  documentId,
  sectionNavigation,
  initialVersionSha,
}: {
  projectId: string;
  documentId: string;
  sectionNavigation?: DocumentSectionNavigation;
  /** Deep link (`?version=`): open compared against this saved version. */
  initialVersionSha?: string;
}) {
  const [mode, setMode] = useState<DocumentMode>(
    initialVersionSha ? "diff" : "document",
  );
  const [editorDirty, setEditorDirty] = useState(false);
  const [selectedVersionSha, setSelectedVersionSha] = useState<
    string | undefined
  >(initialVersionSha);
  const [contextRailOpen, setContextRailOpen] = useState(true);
  const [contextTab, setContextTab] = useState<ContextTab>(
    initialVersionSha ? "history" : "contents",
  );
  const [liveEditor, setLiveEditor] = useState<Editor | null>(null);
  // A Contents jump applies until the linked section (?section=) changes.
  const [outlineJump, setOutlineJump] = useState<{
    linked: string | undefined;
    navigation: DocumentSectionNavigation;
  }>();
  const linkedSection = sectionNavigation
    ? `${sectionNavigation.section}:${sectionNavigation.sourceCommitSha}`
    : undefined;
  const activeSectionNavigation =
    outlineJump && outlineJump.linked === linkedSection
      ? outlineJump.navigation
      : sectionNavigation;
  const [pythonText, setPythonText] = useState<string>();
  const [pythonJump, setPythonJump] = useState<{
    line: number;
    jump: number;
  }>();
  const [contextDrawerOpen, setContextDrawerOpen] = useState(false);
  const [desktopPanels, setDesktopPanels] = useState<boolean>();
  const [historyFocusRequest, setHistoryFocusRequest] = useState(0);
  const contextDrawerCloseFocusPolicyRef =
    useRef<ContextDrawerCloseFocusPolicy>(DEFAULT_CONTEXT_DRAWER_CLOSE_FOCUS);
  const projectQuery = api.project.get.useQuery(
    { projectId },
    { enabled: projectId.length > 0 },
  );
  const documentQuery = api.document.get.useQuery(
    { projectId, documentId },
    {
      enabled: Boolean(projectQuery.data) && documentId.length > 0,
      refetchOnWindowFocus: projectQuery.data
        ? !projectRoleAtLeast(projectQuery.data.myRole, "Editor")
        : false,
    },
  );
  const projectPresentation = resolveQueryPresentation(projectQuery);
  const documentPresentation = resolveQueryPresentation(documentQuery);
  // A deep link to the current version collapses into the editor once (state
  // adjusted during render), so a later save cannot flip the screen to a diff.
  if (
    mode === "diff" &&
    selectedVersionSha !== undefined &&
    selectedVersionSha === initialVersionSha &&
    selectedVersionSha === documentQuery.data?.baseCommitSha
  ) {
    setMode("document");
    setSelectedVersionSha(undefined);
  }
  const historyPaginationKey = `${documentId}:${documentQuery.data?.baseCommitSha ?? "loading"}`;
  const [historyPaginationCache, setHistoryPaginationCache] = useState<{
    key: string;
    pagination: DocumentHistoryPagination;
  }>({ key: historyPaginationKey, pagination: emptyHistoryPagination });
  const historyPagination =
    historyPaginationCache.key === historyPaginationKey
      ? historyPaginationCache.pagination
      : emptyHistoryPagination;
  const setHistoryPagination = useCallback<
    Dispatch<SetStateAction<DocumentHistoryPagination>>
  >(
    (update) => {
      setHistoryPaginationCache((current) => {
        const currentPagination =
          current.key === historyPaginationKey
            ? current.pagination
            : emptyHistoryPagination;
        return {
          key: historyPaginationKey,
          pagination:
            typeof update === "function" ? update(currentPagination) : update,
        };
      });
    },
    [historyPaginationKey],
  );

  useEffect(() => {
    const desktopQuery = window.matchMedia("(min-width: 1280px)");
    const updateDesktopPanels = () => setDesktopPanels(desktopQuery.matches);
    const initializeFrame = window.requestAnimationFrame(() => {
      try {
        setContextRailOpen(readPanelPreference(window.sessionStorage) ?? true);
      } catch {
        setContextRailOpen(true);
      }
      updateDesktopPanels();
    });
    desktopQuery.addEventListener("change", updateDesktopPanels);
    return () => {
      window.cancelAnimationFrame(initializeFrame);
      desktopQuery.removeEventListener("change", updateDesktopPanels);
    };
  }, []);

  const handleContextRailCollapsedChange = useCallback((collapsed: boolean) => {
    const open = !collapsed;
    setContextRailOpen(open);
    try {
      writePanelPreference(window.sessionStorage, open);
    } catch {
      // The in-memory preference still works when storage is unavailable.
    }
  }, []);

  if (projectPresentation === "loading") {
    return <WorkspaceLoading />;
  }

  if (projectPresentation === "error" && projectQuery.error && !editorDirty) {
    return projectQuery.error.data?.code === "NOT_FOUND" ? (
      <WorkspaceNotFound />
    ) : (
      <WorkspaceError
        title="Could not load project"
        description="Refresh the page to try loading this project again."
        action={
          <Button
            type="button"
            variant="outline"
            onClick={() => void projectQuery.refetch()}
          >
            Retry
          </Button>
        }
      />
    );
  }

  if (!projectQuery.data) {
    return <WorkspaceNotFound />;
  }

  if (documentPresentation === "loading") {
    return (
      <WorkspaceLoading
        title="Loading document"
        description="Retrieving the latest document content."
      />
    );
  }

  if (documentPresentation === "error" && documentQuery.error && !editorDirty) {
    return documentQuery.error.data?.code === "NOT_FOUND" ? (
      <WorkspaceNotFound
        title="Document not found"
        description="This document may have been deleted, or you do not have access to it."
      />
    ) : (
      <WorkspaceError
        title="Could not load document"
        description="Refresh the page to retrieve the latest document content."
        action={
          <Button
            type="button"
            variant="outline"
            onClick={() => void documentQuery.refetch()}
          >
            Retry
          </Button>
        }
      />
    );
  }

  if (!documentQuery.data) {
    return (
      <WorkspaceNotFound
        title="Document not found"
        description="This document may have been deleted, or you do not have access to it."
      />
    );
  }

  const project = projectQuery.data;
  const document = documentQuery.data;
  const canEdit =
    projectRoleAtLeast(project.myRole, "Editor") &&
    Boolean(dataUnlessAccessError(project, projectQuery.error)) &&
    Boolean(dataUnlessAccessError(document, documentQuery.error));
  // Destructured from one union so TypeScript treats the two as exclusive.
  let split:
    | { python: PythonDocument; markdown: null }
    | { python: null; markdown: MarkdownDocument };
  if (isPythonDocument(document)) split = { python: document, markdown: null };
  else if (isMarkdownDocument(document))
    split = { python: null, markdown: document };
  else throw new Error("unknown document kind");
  const { python, markdown } = split;
  const outgoingReferences = markdown
    ? collectDocumentReferences(markdown.content.contentJson)
    : [];
  // A deep link to the current version has nothing to compare against.
  const activeMode: DocumentMode =
    mode === "diff" &&
    selectedVersionSha === initialVersionSha &&
    selectedVersionSha === document.baseCommitSha
      ? "document"
      : mode;

  return (
    <DocumentsWorkspace
      contextRailCollapsed={!contextRailOpen}
      onContextRailCollapsedChange={handleContextRailCollapsedChange}
      contextDrawerOpen={contextDrawerOpen}
      onContextDrawerOpenChange={setContextDrawerOpen}
      consumeContextDrawerCloseFocusRequest={() => {
        const result = consumeContextDrawerCloseFocus(
          contextDrawerCloseFocusPolicyRef.current,
        );
        contextDrawerCloseFocusPolicyRef.current = result.nextPolicy;
        return result.preventTriggerRestore;
      }}
      contextRail={
        <ContextRail
          collapsed={!contextRailOpen}
          activeTab={contextTab}
          onActiveTabChange={setContextTab}
          contents={
            python ? (
              <PythonOutlinePanel
                text={pythonText ?? python.content.text}
                navigable={activeMode === "document"}
                onSelect={(line) => {
                  setPythonJump((current) => ({
                    line,
                    jump: (current?.jump ?? 0) + 1,
                  }));
                  if (contextDrawerOpen) {
                    contextDrawerCloseFocusPolicyRef.current =
                      requestSelectionCloseFocus();
                    setContextDrawerOpen(false);
                  }
                }}
              />
            ) : (
              <DocumentOutlinePanel
                editor={activeMode === "document" ? liveEditor : null}
                contentJson={markdown.content.contentJson}
                active={
                  contextTab === "contents" &&
                  (desktopPanels === false
                    ? contextDrawerOpen
                    : contextRailOpen)
                }
                navigable={activeMode === "document"}
                onSelect={(section) => {
                  setOutlineJump((current) => ({
                    linked: linkedSection,
                    navigation: {
                      section,
                      sourceCommitSha: document.baseCommitSha,
                      jump: (current?.navigation.jump ?? 0) + 1,
                    },
                  }));
                  if (contextDrawerOpen) {
                    contextDrawerCloseFocusPolicyRef.current =
                      requestSelectionCloseFocus();
                    setContextDrawerOpen(false);
                  }
                }}
              />
            )
          }
          links={
            <DocumentLinksPanel
              projectId={projectId}
              documentId={documentId}
              outgoing={outgoingReferences}
            />
          }
          index={
            <DocumentIndexPanel
              projectId={projectId}
              documentId={documentId}
              currentSha={document.baseCommitSha}
              active={
                contextTab === "index" &&
                (desktopPanels === false ? contextDrawerOpen : contextRailOpen)
              }
            />
          }
          history={
            <DocumentHistoryPanel
              key={`${documentId}:${document.baseCommitSha}`}
              projectId={projectId}
              documentId={documentId}
              currentSha={document.baseCommitSha}
              selectedSha={selectedVersionSha}
              focusSelectedRequest={historyFocusRequest}
              pagination={historyPagination}
              onPaginationChange={setHistoryPagination}
              onSelectVersion={(sha) => {
                if (
                  !shouldProceedWithNavigation(editorDirty, () =>
                    window.confirm(UNSAVED_CHANGES_CONFIRMATION),
                  )
                ) {
                  return;
                }

                setEditorDirty(false);
                // The editor remounts after the comparison; do not replay a jump.
                setOutlineJump(undefined);
                setPythonJump(undefined);
                setContextTab("history");
                if (contextDrawerOpen) {
                  contextDrawerCloseFocusPolicyRef.current =
                    requestSelectionCloseFocus();
                }
                setContextDrawerOpen(false);
                setSelectedVersionSha(sha);
                setMode("diff");
              }}
            />
          }
        />
      }
    >
      <div data-document-mode={activeMode}>
        {activeMode === "diff" && selectedVersionSha ? (
          <DocumentDiff
            projectId={projectId}
            documentId={documentId}
            fromSha={selectedVersionSha}
            toSha={document.baseCommitSha}
            canEdit={canEdit}
            onBack={() => {
              setMode("document");
              setHistoryFocusRequest((request) => request + 1);
              if (desktopPanels === false) setContextDrawerOpen(true);
            }}
            onRestored={() => {
              setEditorDirty(false);
              setSelectedVersionSha(undefined);
              setMode("document");
            }}
          />
        ) : python ? (
          <>
            <MaintainedByTaskBanner
              projectId={projectId}
              documentId={documentId}
            />
            {(canEdit || editorDirty) &&
            (documentQuery.error || projectQuery.error) ? (
              <p role="alert" className="text-danger px-6">
                The document could not refresh. Your local edits are preserved;
                copy them before leaving this page.
              </p>
            ) : null}
            <DocumentRenderBoundary
              key={python.id}
              fallback={
                <div className="flex flex-col gap-3 px-6 py-8">
                  <p role="alert" className="text-danger">
                    The code editor could not load. The saved file is shown;
                    reload the page to try again.
                  </p>
                  <pre className="whitespace-pre-wrap">
                    {python.content.text}
                  </pre>
                </div>
              }
            >
              <PythonDocumentEditor
                projectId={projectId}
                document={python}
                canEdit={canEdit}
                onDirtyChange={setEditorDirty}
                onTextChange={setPythonText}
                jumpTo={pythonJump}
              />
            </DocumentRenderBoundary>
          </>
        ) : activeMode === "document" && (canEdit || editorDirty) ? (
          <>
            <MaintainedByTaskBanner
              projectId={projectId}
              documentId={documentId}
            />
            {documentQuery.error || projectQuery.error ? (
              <p role="alert" className="text-danger px-6">
                The document could not refresh. Your local edits are preserved;
                copy them before leaving this page.
              </p>
            ) : null}
            <DocumentEditor
              projectId={projectId}
              document={markdown}
              canEdit={canEdit}
              sectionNavigation={activeSectionNavigation}
              onDirtyChange={setEditorDirty}
              onEditorChange={setLiveEditor}
            />
          </>
        ) : (
          <>
            <MaintainedByTaskBanner
              projectId={projectId}
              documentId={documentId}
            />
            <DocumentRenderBoundary
              key={document.baseCommitSha}
              fallback={
                <WorkspaceError
                  title="Could not display document"
                  description="The saved content could not be rendered."
                />
              }
            >
              <DocumentViewer
                projectId={projectId}
                document={markdown}
                sectionNavigation={activeSectionNavigation}
              />
            </DocumentRenderBoundary>
          </>
        )}
      </div>
    </DocumentsWorkspace>
  );
}
