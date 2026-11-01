import { isCoreError } from "@weaver/core/errors";
import {
  problem,
  statusForCoreError,
} from "~/server/ingestion/multipartUpload";
import { BodyTooLargeError } from "./body";

function detail(
  details: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = details?.[key];
  return typeof value === "string" ? value : undefined;
}

export function transferError(error: unknown): Response {
  if (error instanceof BodyTooLargeError) return problem(413, error.message);
  if (error instanceof SyntaxError)
    return problem(400, "body is not valid JSON");
  if (isCoreError(error)) {
    if (detail(error.details, "reason") === "PAYLOAD_TOO_LARGE")
      return problem(413, error.message);
    const field = detail(error.details, "field");
    return problem(
      statusForCoreError(error.code),
      error.message,
      field ? { field } : {},
    );
  }
  throw error;
}
