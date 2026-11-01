import type { TRPCClientErrorLike } from "@trpc/client";
import type { AppRouter } from "~/server/api/root";

type SetError = (name: string, error: { message: string }) => void;

export function applyTrpcErrorToForm(
  err: TRPCClientErrorLike<AppRouter>,
  setError: SetError,
): void {
  const data = err.data as { field?: string } | undefined;
  if (data?.field) {
    setError(data.field, { message: err.message });
  }
}
