import { TRPCError } from "@trpc/server";
import { isCoreError } from "@weaver/core/errors";

export function toTRPCError(error: unknown): TRPCError {
  if (!isCoreError(error)) {
    return error instanceof TRPCError
      ? error
      : new TRPCError({ code: "INTERNAL_SERVER_ERROR", cause: error });
  }

  const mapped = new TRPCError({
    code: error.code,
    message: error.message,
  });
  Object.defineProperty(mapped, "cause", { value: error.details });
  return mapped;
}
