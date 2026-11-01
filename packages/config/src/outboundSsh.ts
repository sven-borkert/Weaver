import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import ipaddr from "ipaddr.js";

function denied(): never {
  throw new Error("SSH target is not allowed");
}
function authority(hostname: string, port: number): string {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}
export async function resolveSshTargetAddress(
  hostname: string,
  port: number,
  options: {
    allowedTargets?: string[];
    resolve?: (hostname: string) => Promise<LookupAddress[]>;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  const allowed = new Set(
    (
      options.allowedTargets ??
      (process.env.WEAVER_GIT_ALLOWED_SSH_TARGETS ?? "")
        .split(",")
        .filter(Boolean)
    ).map((target) => {
      const url = new URL(`ssh://${target.trim()}`);
      if (
        url.username ||
        url.password ||
        url.pathname ||
        url.search ||
        url.hash ||
        !url.hostname
      )
        denied();
      return authority(url.hostname, Number(url.port || 22));
    }),
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  signal.throwIfAborted();
  const resolve =
    options.resolve ?? ((host: string) => lookup(host, { all: true }));
  const addresses = await new Promise<LookupAddress[]>((done, fail) => {
    const abort = () =>
      fail(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("SSH request aborted"),
      );
    signal.addEventListener("abort", abort, { once: true });
    resolve(hostname)
      .then(done, fail)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => undefined);
  });
  signal.throwIfAborted();
  if (!addresses.length) denied();
  const trusted = allowed.has(authority(hostname, port));
  for (const { address } of addresses) {
    if (!ipaddr.isValid(address)) denied();
    if (!trusted && ipaddr.process(address).range() !== "unicast")
      throw new Error(
        `SSH target is not allowed: ${authority(hostname, port)} resolves to the non-public address ${address}; list it in WEAVER_GIT_ALLOWED_SSH_TARGETS to allow it`,
      );
  }
  return addresses[0]!.address;
}
