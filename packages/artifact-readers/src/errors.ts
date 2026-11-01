export const ARTIFACT_READ_ERROR_CODES = [
  "unsupported_format",
  "legacy_format",
  "encrypted",
  "malformed",
  "resource_limit",
  "invalid_path",
  "invalid_input",
  "not_found",
] as const;

export type ArtifactReadErrorCode = (typeof ARTIFACT_READ_ERROR_CODES)[number];

export class ArtifactReadError extends Error {
  constructor(
    readonly code: ArtifactReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactReadError";
  }
}

const NESTING_MESSAGE = "artifact is nested too deeply to read";

/** The recursive walks over a parsed document overflow the stack on hostile
 *  input, and a bare RangeError would escape the closed error list. */
export function rethrowAsReadError(cause: unknown): never {
  if (cause instanceof RangeError) {
    throw new ArtifactReadError("resource_limit", NESTING_MESSAGE);
  }
  throw cause;
}
