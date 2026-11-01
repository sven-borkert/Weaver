const SAFE_ERROR_CLASSES = new Set([
  "AbortError",
  "AggregateError",
  "AiProviderError",
  "CoreError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "URIError",
]);

/** A closed, message-free error class name for diagnostics and stored rows. */
export function safeErrorClass(error: unknown): string {
  let name: unknown;
  try {
    if (!(error instanceof Error)) return "UnknownError";
    name = error.name;
  } catch {
    return "Error";
  }
  return typeof name === "string" && SAFE_ERROR_CLASSES.has(name)
    ? name
    : "Error";
}
