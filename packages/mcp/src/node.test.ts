import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpNodeServer } from "./node";
import { createMcpNodeServer } from "./node";

let server: McpNodeServer | undefined;

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("MCP node adapter", () => {
  it("serves the fetch handler and closes both layers", async () => {
    const close = vi.fn(async () => undefined);
    server = await createMcpNodeServer(
      {
        fetch: async () => Response.json({ status: "ok" }),
        close,
      },
      { port: 0, host: "127.0.0.1" },
    );

    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });

    await server.close();
    server = undefined;
    expect(close).toHaveBeenCalledOnce();
  });

  it("derives the limiter identity from the socket unless an explicit proxy is trusted", async () => {
    const peers: Array<string | undefined> = [];
    server = await createMcpNodeServer(
      {
        fetch: async (_request, context) => {
          peers.push(context?.clientAddress);
          return Response.json({ status: "ok" });
        },
        close: async () => undefined,
      },
      { port: 0, host: "127.0.0.1" },
    );

    await fetch(`http://127.0.0.1:${server.port}/health`, {
      headers: { "x-forwarded-for": "192.0.2.10" },
    });
    await fetch(`http://127.0.0.1:${server.port}/health`, {
      headers: { "x-forwarded-for": "192.0.2.11" },
    });

    expect(peers).toEqual(["127.0.0.1", "127.0.0.1"]);
  });

  it("uses the direct-client right-most X-Forwarded-For hop only at the explicit trusted-proxy boundary", async () => {
    const peers: Array<string | undefined> = [];
    server = await createMcpNodeServer(
      {
        fetch: async (_request, context) => {
          peers.push(context?.clientAddress);
          return Response.json({ status: "ok" });
        },
        close: async () => undefined,
      },
      { port: 0, host: "127.0.0.1", trustProxy: true },
    );

    await fetch(`http://127.0.0.1:${server.port}/health`, {
      headers: { "x-forwarded-for": "198.51.100.11, 192.0.2.10" },
    });

    expect(peers).toEqual(["192.0.2.10"]);
  });

  it("stops admission, drains active requests, and shares concurrent close", async () => {
    const fetchStarted = deferred();
    const fetchRelease = deferred();
    const handlerCloseStarted = deferred();
    const handlerCloseRelease = deferred();
    const fetchHandler = vi.fn(async () => {
      if (fetchHandler.mock.calls.length === 1) {
        fetchStarted.resolve();
        await fetchRelease.promise;
      }
      return Response.json({ status: "ok" });
    });
    const closeHandler = vi.fn(async () => {
      handlerCloseStarted.resolve();
      await handlerCloseRelease.promise;
    });
    server = await createMcpNodeServer(
      { fetch: fetchHandler, close: closeHandler },
      { port: 0, host: "127.0.0.1" },
    );
    const target = `http://127.0.0.1:${server.port}/health`;
    const firstResponse = fetch(target, { headers: { connection: "close" } });
    let firstClose: Promise<void> | undefined;
    let secondClose: Promise<void> | undefined;

    try {
      await fetchStarted.promise;
      firstClose = server.close();
      secondClose = server.close();
      const handlerClosedBeforeDrain = await Promise.race([
        handlerCloseStarted.promise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
      ]);
      const newAdmission = await fetch(target, {
        headers: { connection: "close" },
      }).catch(() => null);
      fetchRelease.resolve();
      expect((await firstResponse).status).toBe(200);
      await handlerCloseStarted.promise;
      handlerCloseRelease.resolve();
      const closeResults = await Promise.allSettled([firstClose, secondClose]);

      expect(handlerClosedBeforeDrain).toBe(false);
      expect(secondClose).toBe(firstClose);
      expect(newAdmission).toBeNull();
      expect(fetchHandler).toHaveBeenCalledOnce();
      expect(closeHandler).toHaveBeenCalledOnce();
      expect(closeResults).toEqual([
        expect.objectContaining({ status: "fulfilled" }),
        expect.objectContaining({ status: "fulfilled" }),
      ]);
    } finally {
      fetchRelease.resolve();
      handlerCloseRelease.resolve();
      await firstResponse.catch(() => undefined);
      await Promise.allSettled([
        firstClose ?? Promise.resolve(),
        secondClose ?? Promise.resolve(),
      ]);
      server = undefined;
    }
  });
});
