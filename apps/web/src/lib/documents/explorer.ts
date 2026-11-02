import type { Appearance } from "@weaver/core/appearance/metadata";
import type { DocumentKind } from "@weaver/core/documents/kinds";
import type { DocumentAuthor } from "@weaver/core/documents/frontmatter";
import type { DocumentIndexLights } from "@weaver/core/documents/indexLight";
import {
  folderHref as genericFolderHref,
  type ExplorerTree as GenericExplorerTree,
  type ItemEntry,
} from "~/lib/explorer/entries";

export type {
  ExplorerDir,
  ExplorerEditor,
  ExplorerSort,
  ExplorerView,
  FolderEntry,
} from "~/lib/explorer/entries";
export {
  folderExists,
  listFolderEntries,
  parentFolder,
  parseFolderParam,
  relativeFolderLabel,
  searchFolderEntries,
  sortEntries,
} from "~/lib/explorer/entries";

/** `lastEditedAt`/`lastEditedBy` carry the document metadata's update. */
export type DocumentItem = {
  id: string;
  title: string;
  path: string;
  documentKind: DocumentKind;
  wikiType?: string | null;
  wikiSummary?: string | null;
  appearance?: Appearance | null;
  /** Null when the document has no review schedule. */
  reviewDueAt: Date | null;
  lastReviewedAt: Date | null;
  createdAt: Date;
  createdBy: DocumentAuthor | null;
  lastEditedAt: Date;
  lastEditedBy: DocumentAuthor | null;
  index: DocumentIndexLights;
};
export type ExplorerTree = GenericExplorerTree<DocumentItem>;
export type DocumentEntry = ItemEntry<DocumentItem>;

export function documentsBase(projectId: string): string {
  return `/projects/${projectId}/documents`;
}
export function folderHref(projectId: string, path: string[]): string {
  return genericFolderHref(documentsBase(projectId), path);
}
export function documentHref(projectId: string, documentId: string): string {
  return `${documentsBase(projectId)}/${documentId}`;
}
