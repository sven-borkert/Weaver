export type QueryPresentation = "data" | "loading" | "error" | "empty";

const accessErrorCodes = new Set(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"]);

export function queryErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("data" in error))
    return undefined;
  const data = error.data;
  if (!data || typeof data !== "object" || !("code" in data)) return undefined;
  return typeof data.code === "string" ? data.code : undefined;
}

export function dataUnlessAccessError<T>(data: T | undefined, error: unknown) {
  return isQueryAccessError(error) ? undefined : data;
}

export function isQueryAccessError(error: unknown): boolean {
  return accessErrorCodes.has(queryErrorCode(error) ?? "");
}

export function resolveQueryPresentation<T>({
  data,
  error,
  isLoading,
}: {
  data: T | undefined;
  error: unknown;
  isLoading: boolean;
}): QueryPresentation {
  if (dataUnlessAccessError(data, error) !== undefined) return "data";
  if (isLoading) return "loading";
  if (error) return "error";
  return "empty";
}
