export type ExternalMcpErrorCode =
  | "INVALID_ENDPOINT"
  | "REDIRECT_REJECTED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "UNSUPPORTED_PROTOCOL"
  | "TOOL_CHANGED"
  | "RESPONSE_TOO_LARGE"
  | "INVALID_CATALOG"
  | "UNSUPPORTED_SCHEMA"
  | "INVALID_ARGUMENTS"
  | "INVALID_RESULT"
  | "TRANSPORT_ERROR"
  | "CANCELLED"
  | "CLOSED"
  | "BUSY";
export class ExternalMcpError extends Error {
  constructor(
    readonly code: ExternalMcpErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ExternalMcpError";
  }
}
