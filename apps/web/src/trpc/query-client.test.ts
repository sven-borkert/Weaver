import { QueryObserver } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { createQueryClient, retireQueryClient } from "./query-client";

it.each([
  "NOT_FOUND",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "BAD_REQUEST",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "TOO_MANY_REQUESTS",
  "PAYMENT_REQUIRED",
  "PRECONDITION_REQUIRED",
])(
  "publishes %s immediately when a cached membership query is refetched",
  async (code) => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {});
    const client = createQueryClient();
    const key = ["project", "membership"];
    const cached = { myRole: "Editor" };
    const error = Object.assign(new Error(code), { data: { code } });
    client.setQueryData(key, cached);
    const query = vi.fn(async () => {
      throw error;
    });
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: query,
      // Node defaults to no retries; reproduce the browser's three-retry default.
      retry: client.getDefaultOptions().queries?.retry ?? 3,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      void observer.refetch();
      await vi.advanceTimersByTimeAsync(0);
      expect(observer.getCurrentResult().error).toBe(error);
      expect(observer.getCurrentResult().data).toEqual(cached);
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
      retireQueryClient(client);
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  },
);

it("retains three retries for transient query failures", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", {});
  const client = createQueryClient();
  const error = new Error("Temporary connection failure");
  const query = vi.fn(async () => {
    throw error;
  });
  const observer = new QueryObserver(client, {
    queryKey: ["transient"],
    queryFn: query,
    retry: client.getDefaultOptions().queries?.retry ?? 3,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  try {
    await vi.advanceTimersByTimeAsync(7_000);
    expect(query).toHaveBeenCalledTimes(4);
    expect(observer.getCurrentResult().error).toBe(error);
  } finally {
    unsubscribe();
    retireQueryClient(client);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("does not reuse fresh account data or publish a late response after retirement", async () => {
  const accountA = createQueryClient();
  accountA.setQueryData(["document", "fresh"], { text: "A private content" });
  let resolveLate!: (value: string) => void;
  const late = accountA
    .fetchQuery({
      queryKey: ["document", "late"],
      queryFn: () =>
        new Promise<string>((resolve) => {
          resolveLate = resolve;
        }),
    })
    .catch(() => undefined);
  retireQueryClient(accountA);
  const accountB = createQueryClient();
  expect(accountB.getQueryData(["document", "fresh"])).toBeUndefined();
  resolveLate("A late private response");
  await late;
  expect(accountA.getQueryCache().getAll()).toEqual([]);
  expect(accountB.getQueryCache().getAll()).toEqual([]);
  retireQueryClient(accountB);
});

it.each([
  { data: { httpStatus: 429 } },
  { meta: { response: new Response(null, { status: 403 }) } },
])("does not retry HTTP-only client errors", (details) => {
  const client = createQueryClient();
  const retry = client.getDefaultOptions().queries!.retry;
  expect(typeof retry).toBe("function");
  if (typeof retry === "function")
    expect(retry(0, Object.assign(new Error("HTTP error"), details))).toBe(
      false,
    );
  retireQueryClient(client);
});
