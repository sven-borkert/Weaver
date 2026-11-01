import { withBasePath } from "~/lib/basePath";

import { uploadWithProgress } from "../../imports/_components/upload";

export type ArtifactUploadResult =
  | { kind: "uploaded"; count: number }
  | { kind: "conflict"; conflicts: string[] }
  | { kind: "error"; message: string; accessDenied: boolean };

export async function uploadArtifacts(
  projectId: string,
  files: File[],
  replace: readonly string[],
  options: {
    fetchImpl?: typeof fetch;
    basePath?: string;
    signal?: AbortSignal;
    onProgress?: (percentage: number) => void;
  } = {},
): Promise<ArtifactUploadResult> {
  const form = new FormData();
  form.set("projectId", projectId);
  for (const name of replace) form.append("replace", name);
  for (const file of files) form.append("file", file);
  const url = withBasePath(
    `/api/projects/${projectId}/artifacts`,
    options.basePath,
  );
  try {
    const response = options.onProgress
      ? await uploadWithProgress(url, form, options)
      : await (options.fetchImpl ?? fetch)(url, {
          method: "POST",
          body: form,
          signal: options.signal,
        });
    const body = (await response.json().catch(() => null)) as {
      artifacts?: unknown[];
      conflicts?: unknown;
      error?: unknown;
    } | null;
    if (response.status === 201)
      return {
        kind: "uploaded",
        count: body?.artifacts?.length ?? files.length,
      };
    const conflicts = Array.isArray(body?.conflicts)
      ? body.conflicts.filter(
          (name): name is string => typeof name === "string",
        )
      : [];
    // An empty list would confirm nothing and retry forever, so it stays an error.
    if (response.status === 409 && conflicts.length)
      return { kind: "conflict", conflicts };
    return {
      kind: "error",
      message:
        [400, 413, 415, 429, 507].includes(response.status) &&
        typeof body?.error === "string"
          ? body.error
          : "Could not upload the files. Try again.",
      accessDenied: [401, 403, 404].includes(response.status),
    };
  } catch {
    return {
      kind: "error",
      message:
        "The upload connection was interrupted. Check the file list before trying again.",
      accessDenied: false,
    };
  }
}
