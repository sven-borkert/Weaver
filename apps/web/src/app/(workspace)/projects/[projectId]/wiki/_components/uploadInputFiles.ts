import { uploadArtifacts } from "../../artifacts/_components/uploadArtifacts";

const MAX_NAME_ATTEMPTS = 20;

/** report.pdf becomes report-2.pdf; the Input page never replaces a file in Files. */
export function suffixedName(name: string, attempt: number): string {
  if (attempt < 2) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? `${name.slice(0, dot)}-${attempt}${name.slice(dot)}`
    : `${name}-${attempt}`;
}

export type InputUploadResult =
  | { kind: "uploaded"; ids: string[] }
  | { kind: "error"; message: string; ids: string[] };

export async function uploadInputFiles(
  projectId: string,
  files: File[],
  options: {
    upload?: typeof uploadArtifacts;
    signal?: AbortSignal;
    onProgress?: (percentage: number) => void;
  } = {},
): Promise<InputUploadResult> {
  const upload = options.upload ?? uploadArtifacts;
  const ids: string[] = [];
  for (const file of files) {
    let done = false;
    for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS && !done; attempt += 1) {
      const named =
        attempt === 1
          ? file
          : new File([file], suffixedName(file.name, attempt), {
              type: file.type,
            });
      const result = await upload(projectId, [named], [], {
        signal: options.signal,
        onProgress: options.onProgress,
      });
      if (result.kind === "uploaded") {
        ids.push(...result.ids);
        done = true;
      } else if (result.kind === "error") {
        return { kind: "error", message: result.message, ids };
      }
    }
    if (!done)
      return {
        kind: "error",
        message: `Could not find a free name for ${file.name} in Files.`,
        ids,
      };
  }
  return { kind: "uploaded", ids };
}
