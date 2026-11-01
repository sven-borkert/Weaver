import { sanitizeText } from "./sanitize";

export type ErrorSummary = {
  name: string;
  message: string;
  code?: string;
  errno?: number;
  syscall?: string;
  hostname?: string;
  cause?: ErrorSummary;
  stack?: string;
};

const MAX_NAME = 80;
const MAX_MESSAGE = 500;
const MAX_CODE = 40;
const MAX_SYSCALL = 40;
const MAX_HOST = 253;
const MAX_STACK = 1_000;
const STACK_FRAMES = 5;
const MAX_DEPTH = 3;

function readString(value: unknown, max: number): string | undefined {
  const text =
    typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== "string") return undefined;
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized ? sanitizeText(normalized, max) : undefined;
}

function prop(error: object, key: string): unknown {
  try {
    return (error as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function stackFrames(stack: unknown): string | undefined {
  if (typeof stack !== "string") return undefined;
  const frames = stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, STACK_FRAMES);
  return frames.length ? sanitizeText(frames.join("\n"), MAX_STACK) : undefined;
}

function summarize(
  error: unknown,
  depth: number,
  seen: Set<unknown>,
): ErrorSummary {
  if (!(error instanceof Error)) {
    let message = "";
    try {
      message = readString(String(error), MAX_MESSAGE) ?? "";
    } catch {
      message = "[unavailable]";
    }
    return { name: "UnknownError", message };
  }
  seen.add(error);
  const summary: ErrorSummary = {
    name: readString(prop(error, "name"), MAX_NAME) ?? "Error",
    message: readString(prop(error, "message"), MAX_MESSAGE) ?? "",
  };
  const code = readString(prop(error, "code"), MAX_CODE);
  if (code) summary.code = code;
  const errno = prop(error, "errno");
  if (typeof errno === "number" && Number.isInteger(errno))
    summary.errno = errno;
  const syscall = readString(prop(error, "syscall"), MAX_SYSCALL);
  if (syscall) summary.syscall = syscall;
  const hostname = readString(prop(error, "hostname"), MAX_HOST);
  if (hostname) summary.hostname = hostname;
  const stack = stackFrames(prop(error, "stack"));
  if (stack) summary.stack = stack;
  if (depth < MAX_DEPTH - 1) {
    let cause = prop(error, "cause");
    if (cause === undefined && error instanceof AggregateError)
      cause = error.errors[0];
    if (cause !== undefined && cause !== null && !seen.has(cause))
      summary.cause = summarize(cause, depth + 1, seen);
  }
  return summary;
}

/** Bounded, redacted view of any thrown value; never throws. */
export function summarizeError(error: unknown): ErrorSummary {
  try {
    return summarize(error, 0, new Set());
  } catch {
    return { name: "UnknownError", message: "[unavailable]" };
  }
}
