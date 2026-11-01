import { CoreError } from "../errors";

const CONTROL_OR_PATH_RE = /[\u0000-\u001f\u007f/\\]/;

function unsafeName(name: string): boolean {
  return (
    name.length === 0 ||
    name.length > 255 ||
    name !== name.trim() ||
    name.startsWith(".") ||
    CONTROL_OR_PATH_RE.test(name)
  );
}

export function validateArtifactFilename(filename: string): void {
  // NFKC folds fullwidth forms onto "." "/" "\\" and can expand a name, so the key is checked too.
  if (unsafeName(filename) || unsafeName(artifactFilenameKey(filename))) {
    throw new CoreError(
      "BAD_REQUEST",
      "filename must be a safe name of 1 to 255 characters that does not start with a dot",
      { field: "filename" },
    );
  }
}

export function artifactFilenameKey(filename: string): string {
  return filename.normalize("NFKC").toLowerCase();
}
