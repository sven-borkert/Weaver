import {
  httpBatchLink,
  httpBatchStreamLink,
  splitLink,
  type HTTPBatchStreamLinkOptions,
  type TRPCLink,
} from "@trpc/client";
import type { AnyRouter } from "@trpc/server";

export function createConfiguredHttpBatchStreamLink<TRouter extends AnyRouter>(
  options: HTTPBatchStreamLinkOptions<TRouter["_def"]["_config"]["$types"]>,
): TRPCLink<TRouter> {
  const configuredOptions = Object.assign({}, options, {
    methodOverride: "POST",
    maxItems: 20,
  });
  return httpBatchStreamLink<TRouter>(configuredOptions);
}

/**
 * Procedures whose response must carry a fresh Set-Cookie (e.g. the rotated
 * session cookie after a password change) can't go through the streaming
 * batch link: @trpc/server's jsonl response computes headers before running
 * the batched procedures (an "eager" head, needed to start streaming the
 * body early), so anything a resolver appends to `ctx.resHeaders` during
 * execution arrives too late to be included. The plain (non-streaming)
 * batch link awaits every call before computing headers, so it still works.
 */
const COOKIE_SENSITIVE_PATHS: ReadonlySet<string> = new Set([
  "account.changePassword",
]);

export function createConfiguredTRPCLink<TRouter extends AnyRouter>(
  options: HTTPBatchStreamLinkOptions<TRouter["_def"]["_config"]["$types"]>,
): TRPCLink<TRouter> {
  return splitLink<TRouter>({
    condition: (op) => COOKIE_SENSITIVE_PATHS.has(op.path),
    true: httpBatchLink<TRouter>(options),
    false: createConfiguredHttpBatchStreamLink<TRouter>(options),
  });
}
