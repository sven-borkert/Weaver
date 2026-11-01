import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent } from "undici";

const guardedFetches = new WeakSet<typeof fetch>();

type Options = {
  allowedOrigins?: string[];
  production?: boolean;
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
  rejectUnauthorized?: boolean;
};

export class OutboundPolicyError extends Error {
  readonly code = "OUTBOUND_NOT_ALLOWED";
  constructor() {
    super("outbound endpoint is not allowed");
    this.name = "OutboundPolicyError";
  }
}

function rejected(): never {
  throw new OutboundPolicyError();
}

export function createPinnedFetch(
  fetchImpl: typeof fetch = fetch,
  options: Options = {},
): typeof fetch {
  if (guardedFetches.has(fetchImpl) && Object.keys(options).length === 0)
    return fetchImpl;
  const production =
    options.production ?? process.env.NODE_ENV === "production";
  const rejectUnauthorized = options.rejectUnauthorized ?? true;
  const allowed = new Set(
    (
      options.allowedOrigins ??
      (process.env.WEAVER_OUTBOUND_ALLOWED_ORIGINS ?? "")
        .split(",")
        .filter(Boolean)
    ).map((value) => {
      const url = new URL(value.trim());
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        rejected();
      return url.origin;
    }),
  );
  const resolve =
    options.resolve ?? ((hostname: string) => lookup(hostname, { all: true }));
  const guarded: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      rejected();
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const signal =
      init?.signal ??
      (input instanceof Request ? input.signal : undefined) ??
      AbortSignal.timeout(30_000);
    signal.throwIfAborted();
    const addresses = await new Promise<LookupAddress[]>((done, fail) => {
      const abort = () =>
        fail(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("outbound request aborted"),
        );
      signal.addEventListener("abort", abort, { once: true });
      resolve(hostname)
        .then(done, fail)
        .finally(() => signal.removeEventListener("abort", abort))
        .catch(() => undefined);
    });
    signal.throwIfAborted();
    if (!addresses.length) rejected();
    const ranges = addresses.map(({ address }) => {
      try {
        return ipaddr.process(address).range();
      } catch {
        return "invalid";
      }
    });
    const trusted = allowed.has(url.origin);
    const localDevelopment =
      !production && ranges.every((range) => range === "loopback");
    if (
      ranges.includes("invalid") ||
      (!trusted &&
        !localDevelopment &&
        (url.protocol !== "https:" ||
          ranges.some((range) => range !== "unicast")))
    )
      rejected();
    const pinned = addresses[0]!;
    const pinnedLookup: LookupFunction = (
      _hostname,
      lookupOptions,
      callback,
    ) => {
      if (lookupOptions.all)
        callback(null, [{ address: pinned.address, family: pinned.family }]);
      else callback(null, pinned.address, pinned.family);
    };
    const dispatcher = new Agent({
      connect: { lookup: pinnedLookup, rejectUnauthorized },
    });
    try {
      const response = await fetchImpl(input, {
        ...init,
        signal,
        redirect: "manual",
        dispatcher,
      } as unknown as RequestInit);
      void dispatcher.close().catch(() => dispatcher.destroy());
      return response;
    } catch (error) {
      await dispatcher.destroy();
      throw error;
    }
  };
  guardedFetches.add(guarded);
  return guarded;
}
