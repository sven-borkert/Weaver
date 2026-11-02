import type { ComponentType, ReactNode, SVGProps } from "react";
import type { ExplorerOperations } from "./useExplorerOperations";
import type { DragDownload } from "~/lib/explorer/drag";
import type {
  ExplorerItem,
  ExplorerTree,
  FolderEntry,
} from "~/lib/explorer/entries";

export type ExplorerTreeQuery<I extends ExplorerItem> = {
  data: ExplorerTree<I> | undefined;
  isLoading: boolean;
  error: unknown;
  refetch: () => unknown;
};

export type ExplorerImport = {
  /** Sentence appended to the header, e.g. "Drop .md files here to import". */
  hint: string;
  /** Live status line while running, e.g. "Importing documents…". */
  status: string;
  importing: boolean;
  /** Rendered by the explorer screen, e.g. a review dialog for dropped archives. */
  dialog?: ReactNode;
  run: (files: File[]) => Promise<void>;
};

export type ExplorerColumn<I extends ExplorerItem> = {
  key: string;
  header: string;
  cell: (item: I) => ReactNode;
  /** Cell of a folder row; a dash when absent. */
  folderCell?: (folder: FolderEntry) => ReactNode;
  className?: string;
  /** Shown only while this returns true for the tree's items; always shown when absent. */
  visible?: (items: I[]) => boolean;
};

/** A select that narrows the list to items sharing one value, searched like the title box. */
export type ExplorerFilter<I extends ExplorerItem> = {
  id: string;
  label: string;
  allLabel: string;
  /** The item's value; null items only match "all". Compared case-insensitively. */
  value: (item: I) => string | null | undefined;
};

export type ExplorerAdapter<I extends ExplorerItem> = {
  kind: "documents" | "tables";
  viewStorageKey: string;
  listLabel: string; // aria-label of the list/grid, e.g. "Documents and folders"
  itemNoun: [singular: string, plural: string]; // ["document", "documents"]
  searchInputId: string; // "document-search" | "table-search"
  itemIcon: (item: I) => ComponentType<SVGProps<SVGSVGElement>>;
  base: (projectId: string) => string; // `/projects/${projectId}/documents`
  itemHref: (projectId: string, item: I) => string;
  useTree: (projectId: string, enabled: boolean) => ExplorerTreeQuery<I>;
  /** Moves one item into a folder (drag and drop); reports its own toasts and invalidations. */
  useMove: (
    projectId: string,
  ) => (itemId: string, folderPath: string[]) => Promise<void>;
  useOperations?: (projectId: string) => ExplorerOperations;
  /** Optional import (drop zone). Return null for none. */
  useImport: (
    projectId: string,
    folderPath: string[],
    canEdit: boolean,
  ) => ExplorerImport | null;
  /** File an item saves as; makes items draggable out of the browser and shows item actions to Viewers. */
  itemDownload?: (projectId: string, item: I) => DragDownload;
  /** Archive of a folder (empty path: the project root); shows folder actions to Viewers. */
  folderDownloadHref?: (projectId: string, path: string[]) => string;
  /** Rendered after the title in both views (documents: IndexLights). */
  itemBadge?: (item: I) => ReactNode;
  /** Extra list columns between Name and Last edited. */
  columns?: ExplorerColumn<I>[];
  /** Optional value filter shown beside Sort; hidden while no item has a value. */
  filter?: ExplorerFilter<I>;
  /** Headers of the edited date and editor columns; "Last edited" / "By" by default. */
  editedHeaders?: { at: string; by: string };
  /** Tile subtitle in icons view; defaults to the last-edited date. */
  tileMeta?: (item: I, formattedDate: string) => ReactNode;
  /** Optional root-only actions, independent of a visible folder entry. */
  rootActions?: (input: { projectId: string }) => ReactNode;
  FolderActions: ComponentType<{
    projectId: string;
    path: string[];
    folders: string[];
    folderNames?: Record<string, string>;
    canEdit: boolean;
    onAppearance?: () => void;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }>;
  ItemActions: ComponentType<{
    projectId: string;
    item: I;
    folderPath: string[];
    folders: string[];
    folderNames?: Record<string, string>;
    canEdit: boolean;
    onAppearance?: () => void;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }>;
  CreateFolderDialog: ComponentType<{
    projectId: string;
    parentPath: string[];
    onFolderCreated: (path: string[]) => void;
  }>;
  CreateItemDialog: ComponentType<{
    projectId: string;
    folderPath: string[];
    folders: string[];
    folderNames?: Record<string, string>;
  }>;
  copy: {
    workspaceLabel: string; // "Document workspace"
    loadingTitle: string; // "Loading documents"
    loadingDescription: string; // "Retrieving folders and documents."
    errorTitle: string; // "Could not load documents"
    notFoundBackLabel: string; // "Back to all documents"
    emptySearchTitle: string; // "No matching documents"
    emptySearchDescription: string; // "Try another title or clear the search."
    emptyFolderTitle: string; // "This folder is empty"
    emptyFolderDescription: string; // "Add a document here or go up a level."
    dropZoneTestId: string; // "documents-drop-zone"
    /** Root-folder empty state override; falls back to <WorkspaceEmpty /> defaults. */
    emptyRootTitle?: string;
    emptyRootDescription?: string;
  };
};
