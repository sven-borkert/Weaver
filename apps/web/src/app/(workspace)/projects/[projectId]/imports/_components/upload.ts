import { MAX_INGESTION_UPLOAD_FILES } from "@weaver/core/ingestion/limits";
import {
  isAllowedMimeType,
  normalizeMimeType,
} from "@weaver/core/ingestion/mimeTypes";
import { withBasePath } from "~/lib/basePath";

const EXTENSION_TYPES: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  pdf: "application/pdf",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
};
export const UPLOAD_ACCEPT = Object.keys(EXTENSION_TYPES)
  .map((extension) => `.${extension}`)
  .join(",");

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function prepareUploadFiles(files: File[], maxBytes: number): File[] {
  if (files.length === 0) throw new Error("Choose at least one file.");
  if (files.length > MAX_INGESTION_UPLOAD_FILES)
    throw new Error(
      `Choose up to ${MAX_INGESTION_UPLOAD_FILES} files at a time.`,
    );
  return files.map((file) => {
    const extension = file.name.includes(".")
      ? file.name.split(".").at(-1)!.toLowerCase()
      : "";
    const type =
      extension === "csv" &&
      normalizeMimeType(file.type) === "application/vnd.ms-excel"
        ? "text/csv"
        : normalizeMimeType(file.type) || (EXTENSION_TYPES[extension] ?? "");
    if (!isAllowedMimeType(type))
      throw new Error(`${file.name}: unsupported file type.`);
    if (file.size > maxBytes)
      throw new Error(`${file.name} is larger than ${formatBytes(maxBytes)}.`);
    return type === file.type
      ? file
      : new File([file], file.name, { type, lastModified: file.lastModified });
  });
}

type UploadResult =
  | { kind: "uploaded" | "pending"; batchId: string }
  | { kind: "error"; message: string; accessDenied: boolean };
export async function uploadFiles(
  projectId: string,
  files: File[],
  maxBytes: number,
  fetchImpl: typeof fetch = fetch,
  basePath?: string,
  options?: { signal?: AbortSignal; onProgress?: (percentage: number) => void },
): Promise<UploadResult> {
  let prepared: File[];
  try {
    prepared = prepareUploadFiles(files, maxBytes);
  } catch (error) {
    return {
      kind: "error",
      message:
        error instanceof Error ? error.message : "Check the selected files.",
      accessDenied: false,
    };
  }
  const form = new FormData();
  form.set("projectId", projectId);
  for (const file of prepared) form.append("file", file);
  try {
    const url = withBasePath("/api/ingestion/uploads", basePath);
    const response = options?.onProgress
      ? await uploadWithProgress(url, form, options)
      : await fetchImpl(url, {
          method: "POST",
          body: form,
          signal: options?.signal,
        });
    const body: unknown = await response.json().catch(() => null);
    const batchId =
      body &&
      typeof body === "object" &&
      "batchId" in body &&
      typeof body.batchId === "string"
        ? body.batchId
        : null;
    if (batchId && (response.ok || response.status === 503))
      return { kind: response.ok ? "uploaded" : "pending", batchId };
    return {
      kind: "error",
      message:
        [400, 413, 415].includes(response.status) &&
        body &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string"
          ? body.error
          : response.status === 503
            ? "Uploads are temporarily unavailable. Try again later."
            : "Could not upload the files. Check the file types and sizes, then try again.",
      accessDenied: [401, 403, 404].includes(response.status),
    };
  } catch {
    return {
      kind: "error",
      message:
        "The upload connection was interrupted. Check the batch list before trying again.",
      accessDenied: false,
    };
  }
}

export function uploadWithProgress(
  url: string,
  form: FormData,
  options: { signal?: AbortSignal; onProgress?: (percentage: number) => void },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => options.signal?.removeEventListener("abort", abort);
    xhr.open("POST", url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        options.onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      cleanup();
      resolve(new Response(xhr.responseText, { status: xhr.status }));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error("Upload connection failed"));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    xhr.send(form);
  });
}
