import {
  documentFileExtension,
  documentFileStem,
  type DocumentKind,
} from "@weaver/core/documents/kinds";
import { withBasePath } from "~/lib/basePath";
import type { DragDownload } from "~/lib/explorer/drag";

/** The stored file of a document, as a download. */
export function documentDownload(
  projectId: string,
  document: {
    id: string;
    path: string;
    title: string;
    documentKind: DocumentKind;
  },
): DragDownload {
  const fileName =
    document.documentKind === "markdown"
      ? document.path.slice(document.path.lastIndexOf("/") + 1)
      : `${document.title.replace(/[\\/]/g, "-")}${documentFileExtension(document.documentKind)}`;
  return {
    fileName,
    href: withBasePath(
      `/api/documents/${document.id}/markdown?projectId=${projectId}`,
    ),
  };
}

/** ZIP of a document and its images. */
export function documentArchiveDownload(
  projectId: string,
  document: { id: string; path: string },
): DragDownload {
  const file = document.path.slice(document.path.lastIndexOf("/") + 1);
  return {
    fileName: `${documentFileStem(file)}.zip`,
    href: withBasePath(
      `/api/documents/${document.id}/archive?projectId=${projectId}`,
    ),
  };
}

/** ZIP of a documents folder; the empty path is the project root. */
export function folderArchiveHref(projectId: string, path: string[]): string {
  const query = path.length
    ? `?path=${encodeURIComponent(path.join("/"))}`
    : "";
  return withBasePath(`/api/projects/${projectId}/folders/archive${query}`);
}
