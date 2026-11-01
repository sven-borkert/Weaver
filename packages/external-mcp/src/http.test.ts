import { expect, it } from "vitest";
import { createBoundedFetch } from "./http";

it("counts streamed bytes without Content-Length before parsing", async () => {
  const bounded = createBoundedFetch({
    endpoint: "https://fixture.test/mcp",
    token: async () => null,
    signal: new AbortController().signal,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(8));
            c.enqueue(new Uint8Array(8));
            c.close();
          },
        }),
      ),
  });
  bounded.reset(10);
  await expect(
    (await bounded.fetch("https://fixture.test/mcp")).text(),
  ).rejects.toThrow("RESPONSE_TOO_LARGE");
});
it("resolves rotated credentials on every redirect request", async () => {
  const seen: (string | null)[] = [];
  let n = 0;
  const bounded = createBoundedFetch({
    endpoint: "https://fixture.test/mcp",
    token: async () => (++n === 1 ? "first" : "second"),
    signal: new AbortController().signal,
    fetchImpl: async (_url, init) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return seen.length === 1
        ? new Response(null, { status: 307, headers: { location: "/next" } })
        : new Response("ok");
    },
  });
  await (await bounded.fetch("https://fixture.test/mcp")).text();
  expect(seen).toEqual(["Bearer first", "Bearer second"]);
});
it.each([302, 307, 308])("blocks unsafe redirects (%s)", async (status) => {
  let calls = 0;
  const bounded = createBoundedFetch({
    endpoint: "https://fixture.test/mcp",
    token: async () => "secret",
    signal: new AbortController().signal,
    fetchImpl: async () => {
      calls++;
      return new Response(null, {
        status,
        headers: { location: "https://other.test/mcp" },
      });
    },
  });
  await expect(bounded.fetch("https://fixture.test/mcp")).rejects.toThrow(
    "REDIRECT_REJECTED",
  );
  expect(calls).toBe(1);
});
it("caps same-origin hops and cumulative page bytes", async () => {
  let calls = 0;
  const bounded = createBoundedFetch({
    endpoint: "https://fixture.test/mcp",
    token: async () => null,
    signal: new AbortController().signal,
    fetchImpl: async () => {
      calls++;
      return new Response(null, {
        status: 308,
        headers: { location: "/next" },
      });
    },
  });
  await expect(bounded.fetch("https://fixture.test/mcp")).rejects.toThrow(
    "REDIRECT_REJECTED",
  );
  expect(calls).toBe(4);
  const pages = createBoundedFetch({
    endpoint: "https://fixture.test/mcp",
    token: async () => null,
    signal: new AbortController().signal,
    fetchImpl: async () => new Response("123456"),
  });
  pages.reset(10);
  await (await pages.fetch("https://fixture.test/mcp")).text();
  await expect(
    (await pages.fetch("https://fixture.test/mcp")).text(),
  ).rejects.toThrow("RESPONSE_TOO_LARGE");
});
it("cancels credential resolution promptly without making an HTTP request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const bounded = createBoundedFetch({
    endpoint: "https://fixture.test/mcp",
    token: () => new Promise(() => undefined),
    signal: controller.signal,
    fetchImpl: async () => {
      calls++;
      return new Response();
    },
  });
  const result = bounded.fetch("https://fixture.test/mcp");
  const assertion = expect(result).rejects.toThrow();
  controller.abort();
  await assertion;
  expect(calls).toBe(0);
}, 300);
it("reports only the final successful canonical endpoint with query semantics intact", async () => {
  const bounded = createBoundedFetch({
    endpoint: "https://fixture.test/mcp",
    token: async () => "bearer-only",
    signal: new AbortController().signal,
    fetchImpl: async (url) =>
      (typeof url === "string"
        ? url
        : url instanceof URL
          ? url.href
          : url.url
      ).endsWith("/mcp")
        ? new Response(null, {
            status: 308,
            headers: { location: "/canonical?tenant=one" },
          })
        : new Response("ok"),
  });
  await (await bounded.fetch("https://fixture.test/mcp")).text();
  expect(bounded.canonicalEndpoint).toBe(
    "https://fixture.test/canonical?tenant=one",
  );
  expect(bounded.canonicalEndpoint).not.toContain("bearer-only");
});
it.each([
  "https://user:password@fixture.test/mcp",
  "https://fixture.test/mcp#fragment",
  `https://fixture.test/${"x".repeat(2048)}`,
])("rejects unsafe or oversized canonical endpoints", async (location) => {
  const bounded = createBoundedFetch({
    endpoint: "https://fixture.test/mcp",
    token: async () => null,
    signal: new AbortController().signal,
    fetchImpl: async () =>
      new Response(null, { status: 307, headers: { location } }),
  });
  await expect(bounded.fetch("https://fixture.test/mcp")).rejects.toThrow(
    "INVALID_ENDPOINT",
  );
});
