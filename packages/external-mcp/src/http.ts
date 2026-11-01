import { ExternalMcpError } from "./errors";

export function endpointUrl(value: string | URL) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ExternalMcpError("INVALID_ENDPOINT");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.href.length > 2048
  )
    throw new ExternalMcpError("INVALID_ENDPOINT");
  return url;
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ExternalMcpError("CANCELLED"));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => undefined);
  });
}

export function createBoundedFetch(options: {
  endpoint: string;
  token: () => Promise<string | null>;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}) {
  const initialUrl = endpointUrl(options.endpoint);
  const origin = initialUrl.origin;
  let canonicalEndpoint = initialUrl.href;
  let operationSignal = options.signal;
  let used = 0;
  let limit = 2 * 1024 * 1024;
  const boundedFetch: typeof fetch = async (input, init) => {
    let url = endpointUrl(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin) throw new ExternalMcpError("REDIRECT_REJECTED");
    const signal = AbortSignal.any([
      options.signal,
      operationSignal,
      ...(init?.signal ? [init.signal] : []),
    ]);
    for (let hop = 0; ; hop++) {
      signal.throwIfAborted();
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      headers.delete("authorization");
      const token = await abortable(options.token(), signal);
      signal.throwIfAborted();
      if (token) headers.set("authorization", `Bearer ${token}`);
      const response = await options.fetchImpl(url, {
        ...init,
        headers,
        redirect: "manual",
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (![307, 308].includes(response.status) || !location || hop >= 3)
          throw new ExternalMcpError("REDIRECT_REJECTED");
        const next = endpointUrl(new URL(location, url));
        if (next.origin !== origin)
          throw new ExternalMcpError("REDIRECT_REJECTED");
        url = next;
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new ExternalMcpError(
          response.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
        );
      }
      const length = Number(response.headers.get("content-length"));
      if (length > limit - used) {
        await response.body?.cancel();
        throw new ExternalMcpError("RESPONSE_TOO_LARGE");
      }
      if (response.ok) canonicalEndpoint = url.href;
      if (!response.body) return response;
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            signal.throwIfAborted();
            const chunk = await abortable(reader.read(), signal);
            if (chunk.done) {
              controller.close();
              return;
            }
            used += chunk.value.byteLength;
            if (used > limit) {
              await reader.cancel();
              throw new ExternalMcpError("RESPONSE_TOO_LARGE");
            }
            controller.enqueue(chunk.value);
          } catch (error) {
            controller.error(error);
            await reader.cancel().catch(() => undefined);
          }
        },
        cancel: (reason) => reader.cancel(reason),
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
  };
  return {
    fetch: boundedFetch,
    get canonicalEndpoint() {
      return canonicalEndpoint;
    },
    setSignal(signal: AbortSignal) {
      operationSignal = signal;
    },
    reset(bytes: number) {
      used = 0;
      limit = bytes;
    },
    get bytes() {
      return used;
    },
  };
}
