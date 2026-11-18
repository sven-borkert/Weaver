export function localDocumentsHref(
  projectId: string,
  selection?: { document: string } | { folder: string },
): string {
  const path = `/projects/${encodeURIComponent(projectId)}/documents/local`;
  return selection ? `${path}?${new URLSearchParams(selection)}` : path;
}
