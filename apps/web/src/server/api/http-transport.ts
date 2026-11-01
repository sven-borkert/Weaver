import type { AnyRouter } from "@trpc/server";
import {
  fetchRequestHandler,
  type FetchHandlerRequestOptions,
} from "@trpc/server/adapters/fetch";

const MAX_BODY_BYTES = 16 * 1024 * 1024;

export async function handleTrpcFetchRequest<TRouter extends AnyRouter>(
  options: FetchHandlerRequestOptions<TRouter> & { appOrigin?: string },
): Promise<Response> {
  let req = options.req;
  const suppliedOrigin = req.headers.get("origin");
  const expectedOrigin = new URL(options.appOrigin ?? req.url).origin;
  if (
    (suppliedOrigin && suppliedOrigin !== expectedOrigin) ||
    (req.method === "POST" && !suppliedOrigin) ||
    req.headers.get("sec-fetch-site") === "cross-site"
  ) {
    return Response.json(
      { error: "Same-origin request required" },
      { status: 403 },
    );
  }
  if (req.method === "POST") {
    if (
      req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
    ) {
      return Response.json({ error: "JSON content required" }, { status: 415 });
    }
    const declared = Number(req.headers.get("content-length"));
    if (declared > MAX_BODY_BYTES) return new Response(null, { status: 413 });
    if (req.body) {
      const reader = req.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY_BYTES) {
            await reader.cancel();
            return new Response(null, { status: 413 });
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      req = new Request(req.url, {
        method: req.method,
        headers: req.headers,
        signal: req.signal,
        body: Buffer.concat(chunks),
      });
    }
  }
  return fetchRequestHandler({
    ...options,
    req,
    allowMethodOverride: true,
    maxBatchSize: 20,
  });
}
