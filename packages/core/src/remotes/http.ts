import { createPinnedFetch } from "@weaver/config/outboundFetch";

export class RemoteHttpError extends Error {
  constructor(
    readonly status: number,
    readonly bodyText: string,
    url: string,
  ) {
    super(`remote request failed with ${status} for ${new URL(url).pathname}`);
  }
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

/** The pinned outbound fetch with the remote's own origin allowed; nothing else changes. */
export function remoteFetchFor(
  fetchImpl: typeof fetch,
  baseUrl: string,
  allowedOrigins: string[] = [],
): typeof fetch {
  return createPinnedFetch(fetchImpl, {
    allowedOrigins: [...allowedOrigins, new URL(baseUrl).origin],
  });
}

export async function remoteJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit & { maxBytes?: number; timeoutMs?: number },
): Promise<T> {
  const {
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    ...rest
  } = init;
  const response = await fetchImpl(url, {
    ...rest,
    signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
  });
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new Error("remote response too large");

  // Stream the body to bound memory usage
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = response.body?.getReader();

  if (reader) {
    let done = false;
    while (!done) {
      const { done: isDone, value } = await reader.read();
      done = isDone;
      if (!done && value) {
        totalBytes += value.length;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new Error("remote response too large");
        }
        chunks.push(value);
      }
    }
  }

  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  const text = new TextDecoder("utf-8").decode(combined);
  if (response.status < 200 || response.status >= 300)
    throw new RemoteHttpError(response.status, text.slice(0, 2_000), url);
  return JSON.parse(text) as T;
}
