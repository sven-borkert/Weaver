import { DOCUMENT_IMAGE_TYPES } from "@weaver/core/documents/images";
import { withBasePath } from "~/lib/basePath";

export type UploadedDocumentImage = {
  src: string;
  path: string;
  url: string;
  contentType: string;
  byteSize: number;
  commitSha: string;
};

export const DOCUMENT_IMAGE_ACCEPT = DOCUMENT_IMAGE_TYPES.join(",");

export function isDocumentImageFile(file: File): boolean {
  return (DOCUMENT_IMAGE_TYPES as readonly string[]).includes(file.type);
}

export function altFromFileName(name: string): string {
  return name
    .replace(/\.[^.]*$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function uploadDocumentImage(input: {
  projectId: string;
  documentId: string;
  file: File;
  signal?: AbortSignal;
}): Promise<UploadedDocumentImage> {
  const form = new FormData();
  form.set("projectId", input.projectId);
  form.append("file", input.file, input.file.name || "image");
  const response = await fetch(
    withBasePath(`/api/documents/${input.documentId}/images`),
    {
      method: "POST",
      body: form,
      credentials: "same-origin",
      signal: input.signal,
    },
  );
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message =
      body &&
      typeof body === "object" &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Upload failed (${response.status})`;
    throw new Error(message);
  }
  return (await response.json()) as UploadedDocumentImage;
}
