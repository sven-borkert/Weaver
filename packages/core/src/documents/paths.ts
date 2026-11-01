import { CoreError } from "@weaver/core/errors";
import { documentFileExtension, type DocumentKind } from "./kinds";

export const MAX_FOLDER_DEPTH = 10;
export const SEGMENT_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

export class PathError extends Error {}

function assertSafeSegment(s: string): void {
  if (!SEGMENT_RE.test(s) || s === ".git" || s.includes("..")) {
    throw new PathError(`invalid path segment: ${JSON.stringify(s)}`);
  }
}

export function assertSafeSegments(segments: string[]): void {
  if (segments.length > MAX_FOLDER_DEPTH) {
    throw new PathError(`folder depth exceeds ${MAX_FOLDER_DEPTH}`);
  }
  for (const s of segments) {
    assertSafeSegment(s);
  }
}

export const FOLDER_NOT_FOUND = "FOLDER_NOT_FOUND";

/** A named folder is absent; callers already proved project access, so saying so leaks nothing. */
export function folderNotFound(field: string): CoreError {
  return new CoreError("NOT_FOUND", "folder does not exist", {
    reason: FOLDER_NOT_FOUND,
    field,
  });
}

export function docPath(
  folder: string[],
  slug: string,
  kind: DocumentKind,
): string {
  assertSafeSegments(folder);
  assertSafeSegment(slug);
  return [...folder, `${slug}${documentFileExtension(kind)}`].join("/");
}

export function folderPathOfDocPath(p: string): string[] {
  return p.split("/").slice(0, -1);
}
