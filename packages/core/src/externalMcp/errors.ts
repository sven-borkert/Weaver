import type { ExternalMcpErrorCode } from "@weaver/external-mcp";

export const EXTERNAL_ERROR_MESSAGES = {
  EXTERNAL_AUTH_FAILED:
    "External authentication failed. Update the connection's token under Account › MCP connections.",
  EXTERNAL_FORBIDDEN:
    "External access was forbidden. Check your permissions in the connected app.",
  EXTERNAL_UNAVAILABLE:
    "The external service is unavailable. Check its connection before trying again.",
  EXTERNAL_TOOL_CHANGED:
    "The external tool changed or was removed. Rediscover and review it before trying again.",
  EXTERNAL_INPUT_INVALID:
    "External arguments are invalid. Review the input values.",
  EXTERNAL_UNSUPPORTED_PROTOCOL:
    "The external protocol is unsupported. Review the server protocol configuration.",
  EXTERNAL_UNSUPPORTED_SCHEMA:
    "The external schema is unsupported. Review the tool under Account › MCP connections.",
  EXTERNAL_TIMEOUT:
    "The external request timed out or was interrupted. Check the external service before trying again.",
  EXTERNAL_RESPONSE_TOO_LARGE:
    "The external response exceeded its limit. Narrow the requested data before trying again.",
  EXTERNAL_INVALID_RESULT:
    "The external result did not match the tool contract. Review the tool under Account › MCP connections.",
  EXTERNAL_TOOL_ERROR:
    "The external tool reported an error. Review the request before trying again.",
  EXTERNAL_OUTCOME_UNKNOWN:
    "The external outcome could not be confirmed. Check the external service before trying again.",
  EXTERNAL_TOOL_DENIED: "You denied this external tool call.",
  EXTERNAL_CALL_INVALIDATED:
    "The external call was not dispatched. Review access and submit a new message if needed.",
} as const;
export type ExternalErrorCode = keyof typeof EXTERNAL_ERROR_MESSAGES;
export const EXTERNAL_UNKNOWN_WARNING =
  "The remote operation may have completed. This call was not replayed automatically; check the external service before trying again.";
export function externalError(code: unknown) {
  const safeCode: ExternalErrorCode =
    typeof code === "string" && Object.hasOwn(EXTERNAL_ERROR_MESSAGES, code)
      ? (code as ExternalErrorCode)
      : "EXTERNAL_OUTCOME_UNKNOWN";
  return { code: safeCode, message: EXTERNAL_ERROR_MESSAGES[safeCode] };
}
const TRANSPORT_CODES: Record<ExternalMcpErrorCode, ExternalErrorCode> = {
  UNAUTHORIZED: "EXTERNAL_AUTH_FAILED",
  FORBIDDEN: "EXTERNAL_FORBIDDEN",
  UNSUPPORTED_PROTOCOL: "EXTERNAL_UNSUPPORTED_PROTOCOL",
  TOOL_CHANGED: "EXTERNAL_TOOL_CHANGED",
  INVALID_ENDPOINT: "EXTERNAL_UNAVAILABLE",
  REDIRECT_REJECTED: "EXTERNAL_UNAVAILABLE",
  RESPONSE_TOO_LARGE: "EXTERNAL_RESPONSE_TOO_LARGE",
  INVALID_CATALOG: "EXTERNAL_TOOL_CHANGED",
  UNSUPPORTED_SCHEMA: "EXTERNAL_UNSUPPORTED_SCHEMA",
  INVALID_ARGUMENTS: "EXTERNAL_INPUT_INVALID",
  INVALID_RESULT: "EXTERNAL_INVALID_RESULT",
  TRANSPORT_ERROR: "EXTERNAL_UNAVAILABLE",
  CANCELLED: "EXTERNAL_TIMEOUT",
  CLOSED: "EXTERNAL_UNAVAILABLE",
  BUSY: "EXTERNAL_UNAVAILABLE",
};
export function externalTransportError(code: ExternalMcpErrorCode) {
  return externalError(TRANSPORT_CODES[code]);
}
