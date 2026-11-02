"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";

import { MAX_MARKDOWN_CHARS } from "@weaver/core/documents/limits";
import { decodeUtf8Strict, isPlainText } from "@weaver/core/documents/text";
import { useBackgroundWork } from "~/components/background-work/BackgroundWorkProvider";
import type {
  ExplorerAdapter,
  ExplorerImport,
} from "~/components/explorer/adapter";
import {
  documentHref,
  documentsBase,
  type DocumentItem,
} from "~/lib/documents/explorer";
import { invalidateDocumentReferenceCaches } from "~/lib/documents/document-cache-invalidation";
import {
  documentArchiveDownload,
  documentDownload,
  folderArchiveHref,
} from "~/lib/documents/download";
import { partitionDroppedFiles } from "~/lib/documents/document-drop";
import { documentKindIcon } from "~/components/icons/document-kind-icon";
import { Button } from "~/components/ui/button";
import { ClientDateTime } from "~/components/ui/client-date";
import { api } from "~/trpc/react";
import { useExplorerOperations } from "~/components/explorer/useExplorerOperations";
import { CreateDocumentDialog } from "./CreateDocumentDialog";
import { CreateFolderDialog } from "./CreateFolderDialog";
import { DocumentMutations } from "./DocumentMutations";
import { FolderMutations, DocumentRootReviewAction } from "./FolderMutations";
import { ImportZipDialog } from "./ImportZipDialog";
import { IndexLights } from "./IndexLights";
import { ReviewStatusIcon } from "./ReviewStatusIcon";

function useDocumentsTree(projectId: string, enabled: boolean) {
  const { pageVisible } = useBackgroundWork();
  const query = api.folder.tree.useQuery(
    { projectId },
    {
      enabled,
      refetchInterval: pageVisible ? 30_000 : false,
      refetchIntervalInBackground: false,
    },
  );
  const data = useMemo(
    () =>
      query.data
        ? {
            folders: query.data.folders,
            folderNames: query.data.folderNames,
            folderStamps: query.data.folderStamps,
            folderAppearances: query.data.folderAppearances,
            items: query.data.documents,
          }
        : undefined,
    [query.data],
  );
  return {
    data,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => query.refetch(),
  };
}

function useFileImport(
  projectId: string,
  folderPath: string[],
  canEdit: boolean,
): ExplorerImport | null {
  const utils = api.useUtils();
  const importFile = api.document.importFile.useMutation();
  const [importing, setImporting] = useState(false);
  const importingRef = useRef(false);
  const [archives, setArchives] = useState<File[]>([]);
  if (!canEdit) return null;
  return {
    hint: "Drop .md, .py or .zip files here to import",
    status: "Importing documents…",
    importing,
    dialog: archives[0] ? (
      <ImportZipDialog
        key={`${archives.length}:${archives[0].name}`}
        projectId={projectId}
        folderPath={folderPath}
        file={archives[0]}
        onClose={() => setArchives((queue) => queue.slice(1))}
      />
    ) : null,
    run: async (files) => {
      if (importingRef.current) {
        toast.error("An import is already running. Wait for it to finish.");
        return;
      }
      const {
        documents,
        archives: dropped,
        ignored,
      } = partitionDroppedFiles(files);
      if (ignored.length)
        toast.error(
          `Ignored ${ignored.length} file${ignored.length === 1 ? "" : "s"}: only .md, .markdown, .py and .zip files are imported.`,
        );
      if (dropped.length) setArchives((queue) => [...queue, ...dropped]);
      if (!documents.length) return;
      importingRef.current = true;
      setImporting(true);
      let imported = 0;
      const failures: string[] = [];
      try {
        for (const file of documents) {
          try {
            if (file.size > MAX_MARKDOWN_CHARS * 4) {
              failures.push(`${file.name} (too large)`);
              continue;
            }
            const text = decodeUtf8Strict(
              new Uint8Array(await file.arrayBuffer()),
            );
            if (text === null || !isPlainText(text)) {
              failures.push(`${file.name} (not a text file)`);
              continue;
            }
            if (text.length > MAX_MARKDOWN_CHARS) {
              failures.push(`${file.name} (too large)`);
              continue;
            }
            const result = await importFile.mutateAsync({
              projectId,
              folderPath,
              fileName: file.name,
              text,
            });
            for (const warning of result?.warnings ?? [])
              toast.warning(warning);
            imported += 1;
          } catch {
            failures.push(file.name);
          }
        }
      } finally {
        importingRef.current = false;
        setImporting(false);
        void utils.folder.tree.invalidate({ projectId });
        void utils.document.list.invalidate({ projectId });
      }
      if (imported)
        toast.success(
          `Imported ${imported} document${imported === 1 ? "" : "s"}`,
        );
      if (failures.length)
        toast.error(`Could not import: ${failures.join(", ")}`);
    },
  };
}

function useMoveDocument(projectId: string) {
  const utils = api.useUtils();
  const moveDocument = api.document.move.useMutation();
  return async (documentId: string, folderPath: string[]) => {
    try {
      await moveDocument.mutateAsync({ projectId, documentId, folderPath });
      toast.success("Document moved");
    } catch {
      toast.error("Could not move the document");
    } finally {
      void utils.document.list.invalidate({ projectId });
      void utils.document.get.invalidate({ projectId, documentId });
      void utils.folder.tree.invalidate({ projectId });
      void utils.document.history.invalidate({ projectId, documentId });
      void utils.document.backlinks.invalidate({ projectId });
      void invalidateDocumentReferenceCaches(utils, projectId);
    }
  };
}

function DocumentItemActions({
  item,
  folderPath,
  ...rest
}: {
  projectId: string;
  item: DocumentItem;
  folderPath: string[];
  folders: string[];
  folderNames?: Record<string, string>;
  canEdit: boolean;
  onAppearance?: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DocumentMutations
      documentId={item.id}
      documentTitle={item.title}
      documentFolderPath={folderPath}
      download={documentDownload(rest.projectId, item)}
      archive={documentArchiveDownload(rest.projectId, item)}
      {...rest}
    />
  );
}

function DocumentCreateItemDialog({
  projectId,
  folderPath,
}: {
  projectId: string;
  folderPath: string[];
  folders: string[];
  folderNames?: Record<string, string>;
}) {
  return <CreateDocumentDialog projectId={projectId} folderPath={folderPath} />;
}

export const documentsExplorerAdapter: ExplorerAdapter<DocumentItem> = {
  kind: "documents",
  viewStorageKey: "weaver-documents-view",
  listLabel: "Documents and folders",
  itemNoun: ["document", "documents"],
  searchInputId: "document-search",
  itemIcon: (item) => documentKindIcon(item.documentKind),
  base: documentsBase,
  itemHref: (projectId, item) => documentHref(projectId, item.id),
  useTree: useDocumentsTree,
  useMove: useMoveDocument,
  useOperations: (projectId) => useExplorerOperations(projectId, "documents"),
  useImport: useFileImport,
  itemDownload: documentDownload,
  folderDownloadHref: folderArchiveHref,
  itemBadge: (item) => (
    <span className="inline-flex items-center gap-1.5">
      <IndexLights lights={item.index} />
      <ReviewStatusIcon review={item} />
    </span>
  ),
  columns: [
    {
      key: "type",
      header: "Type",
      cell: (item) => item.wikiType ?? "—",
      className: "text-text-2 max-w-32 truncate",
      visible: (items) => items.some((item) => item.wikiType),
    },
    {
      key: "summary",
      header: "Summary",
      cell: (item) =>
        item.wikiSummary ? (
          <span title={item.wikiSummary}>{item.wikiSummary}</span>
        ) : (
          "—"
        ),
      className: "text-text-2 max-w-64 truncate",
      visible: (items) => items.some((item) => item.wikiSummary),
    },
    {
      key: "created",
      header: "Created",
      cell: (item) => <ClientDateTime value={item.createdAt} />,
      folderCell: (folder) =>
        folder.createdAt ? <ClientDateTime value={folder.createdAt} /> : "—",
      className: "text-text-2 whitespace-nowrap",
    },
    {
      key: "createdBy",
      header: "Created by",
      cell: (item) => item.createdBy?.name ?? "—",
      folderCell: (folder) => folder.createdBy?.name ?? "—",
      className: "text-text-2 max-w-48 truncate",
    },
  ],
  filter: {
    id: "type",
    label: "Type",
    allLabel: "All types",
    value: (item) => item.wikiType,
  },
  editedHeaders: { at: "Updated", by: "Updated by" },
  FolderActions: FolderMutations,
  rootActions: ({ projectId }) => (
    <>
      <Button asChild variant="outline" size="sm">
        <Link href={`${documentsBase(projectId)}/index-view`}>Index view</Link>
      </Button>
      <DocumentRootReviewAction projectId={projectId} />
    </>
  ),
  ItemActions: DocumentItemActions,
  CreateFolderDialog,
  CreateItemDialog: DocumentCreateItemDialog,
  copy: {
    workspaceLabel: "Document workspace",
    loadingTitle: "Loading documents",
    loadingDescription: "Retrieving folders and documents.",
    errorTitle: "Could not load documents",
    notFoundBackLabel: "Back to all documents",
    emptySearchTitle: "No matching documents",
    emptySearchDescription: "Try another title or clear the search.",
    emptyFolderTitle: "This folder is empty",
    emptyFolderDescription: "Add a document here or go up a level.",
    dropZoneTestId: "documents-drop-zone",
  },
};
