export const CORE_ERROR_CODES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "TOO_MANY_REQUESTS",
  "INTERNAL_SERVER_ERROR",
] as const;

export type CoreErrorCode = (typeof CORE_ERROR_CODES)[number];

export class CoreError extends Error {
  constructor(
    readonly code: CoreErrorCode,
    message: string = code,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "CoreError";
  }
}

export function isCoreError(value: unknown): value is CoreError {
  return value instanceof CoreError;
}
