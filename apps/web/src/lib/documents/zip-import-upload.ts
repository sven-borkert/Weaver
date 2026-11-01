import type { FolderMetadata } from "@weaver/core/documents/folderMetadata";
import type { DocumentKind } from "@weaver/core/documents/kinds";
import { withBasePath } from "~/lib/basePath";

export type ArchiveUploadTarget =
  | { mode: "create" }
  | { mode: "replace"; documentId: string; expectedHeadCommitSha: string };

/** Sends one previewed document with its images; rejects with the server's message. */
export async function uploadArchiveDocument(input: {
  projectId: string;
  folderPath: string[];
  folderNames: Record<string, string>;
  folderMetadata?: Record<string, FolderMetadata>;
  icons?: Array<{ name: string; blob: Blob }>;
  kind: DocumentKind;
  fileName: string;
  text: string;
  images: Array<{ name: string; blob: Blob }>;
  target: ArchiveUploadTarget;
  signal?: AbortSignal;
}): Promise<{ id: string; title: string; path: string }> {
  const form = new FormData();
  form.set("folderPath", JSON.stringify(input.folderPath));
  form.set("folderNames", JSON.stringify(input.folderNames));
  form.set("mode", input.target.mode);
  if (input.folderMetadata)
    form.set("folderMetadata", JSON.stringify(input.folderMetadata));
  for (const icon of input.icons ?? [])
    form.append("icon", new File([icon.blob], icon.name));
  if (input.target.mode === "replace") {
    form.set("targetDocumentId", input.target.documentId);
    form.set("expectedHeadCommitSha", input.target.expectedHeadCommitSha);
  }
  form.set(input.kind, new File([input.text], input.fileName));
  for (const image of input.images)
    form.append("image", new File([image.blob], image.name));
  const response = await fetch(
    withBasePath(`/api/projects/${input.projectId}/documents/import`),
    { method: "POST", body: form, signal: input.signal },
  );
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    id?: string;
    title?: string;
    path?: string;
  } | null;
  if (!response.ok || !body?.id || !body.title || !body.path)
    throw new Error(body?.error ?? `import failed (${response.status})`);
  return { id: body.id, title: body.title, path: body.path };
}

export async function uploadArchiveFolders(input: {
  projectId: string;
  folderPath: string[];
  folderMetadata: Record<string, FolderMetadata>;
  icons: Array<{ name: string; blob: Blob }>;
  signal?: AbortSignal;
}): Promise<void> {
  const form = new FormData();
  form.set("mode", "folders");
  form.set("folderPath", JSON.stringify(input.folderPath));
  form.set("folderNames", "{}");
  form.set("folderMetadata", JSON.stringify(input.folderMetadata));
  for (const icon of input.icons)
    form.append("icon", new File([icon.blob], icon.name));
  const response = await fetch(
    withBasePath(`/api/projects/${input.projectId}/documents/import`),
    { method: "POST", body: form, signal: input.signal },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `import failed (${response.status})`);
  }
}
