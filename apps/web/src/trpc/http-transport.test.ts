import { createTRPCClient } from "@trpc/client";
import { initTRPC } from "@trpc/server";
import SuperJSON from "superjson";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { handleTrpcFetchRequest } from "~/server/api/http-transport";
import {
  createConfiguredHttpBatchStreamLink,
  createConfiguredTRPCLink,
} from "./http-transport";

const t = initTRPC.create({ transformer: SuperJSON });
const transportTestRouter = t.router({
  resolveRefs: t.procedure
    .input(z.object({ ids: z.array(z.string()) }))
    .query(({ input }) => ({ count: input.ids.length })),
});

type TransportTestRouter = typeof transportTestRouter;

describe("configured tRPC HTTP transport", () => {
  it("sends a maximum-size reference query in the POST body and serves it through method override", async () => {
    const ids = Array.from(
      { length: 25_000 },
      (_, index) =>
        `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    );
    let capturedRequest: Request | undefined;
    const client = createTRPCClient<TransportTestRouter>({
      links: [
        createConfiguredHttpBatchStreamLink<TransportTestRouter>({
          transformer: SuperJSON,
          url: "http://localhost/api/trpc",
          fetch: async (url, init) => {
            const request = new Request(url, init);
            request.headers.set("origin", "http://localhost");
            capturedRequest = request.clone();
            return handleTrpcFetchRequest({
              endpoint: "/api/trpc",
              req: request,
              router: transportTestRouter,
            });
          },
        }),
      ],
    });

    await expect(client.resolveRefs.query({ ids })).resolves.toEqual({
      count: 25_000,
    });

    if (!capturedRequest) {
      throw new Error("The configured link did not emit a request");
    }
    expect(capturedRequest.method).toBe("POST");
    expect(new URL(capturedRequest.url).searchParams.has("input")).toBe(false);
    const body: unknown = await capturedRequest.json();
    expect(body).toEqual({ 0: { json: { ids } } });
  });
});

describe("createConfiguredTRPCLink", () => {
  /**
   * @trpc/server computes the streaming (jsonl) batch response's headers
   * *before* running the batched procedures, so a resolver's
   * `ctx.resHeaders.append("set-cookie", ...)` never reaches the client
   * through the default streaming link — see account.changePassword, which
   * needs its rotated session cookie forwarded. This split link routes a
   * cookie-sensitive path through the plain (non-streaming) batch link
   * instead, whose response headers are computed after every call resolves.
   */
  const splitTestT = initTRPC
    .context<{ resHeaders?: Headers }>()
    .create({ transformer: SuperJSON });
  const splitTestRouter = splitTestT.router({
    account: splitTestT.router({
      changePassword: splitTestT.procedure.mutation(({ ctx }) => {
        ctx.resHeaders?.append("set-cookie", "session=rotated; Path=/");
        return null;
      }),
    }),
    ping: splitTestT.procedure.query(() => "pong"),
  });
  type SplitTestRouter = typeof splitTestRouter;

  function clientFor(
    capturedRequests: Request[],
    capturedResponses: Response[],
  ) {
    return createTRPCClient<SplitTestRouter>({
      links: [
        createConfiguredTRPCLink<SplitTestRouter>({
          transformer: SuperJSON,
          url: "http://localhost/api/trpc",
          fetch: async (url, init) => {
            const request = new Request(url, init);
            request.headers.set("origin", "http://localhost");
            capturedRequests.push(request.clone());
            const response = await handleTrpcFetchRequest({
              endpoint: "/api/trpc",
              req: request,
              router: splitTestRouter,
              createContext: ({ resHeaders }) => ({ resHeaders }),
            });
            capturedResponses.push(response.clone());
            return response;
          },
        }),
      ],
    });
  }

  it("forwards a Set-Cookie appended inside account.changePassword's resolver", async () => {
    const capturedRequests: Request[] = [];
    const capturedResponses: Response[] = [];
    const client = clientFor(capturedRequests, capturedResponses);

    await client.account.changePassword.mutate();

    const changePasswordRequest = capturedRequests.find((request) =>
      request.url.includes("account.changePassword"),
    );
    expect(changePasswordRequest?.headers.get("trpc-accept")).not.toBe(
      "application/jsonl",
    );
    expect(capturedResponses[0]?.headers.get("set-cookie")).toBe(
      "session=rotated; Path=/",
    );
  });

  it("still routes an unrelated call through the streaming batch link", async () => {
    const capturedRequests: Request[] = [];
    const capturedResponses: Response[] = [];
    const client = clientFor(capturedRequests, capturedResponses);

    await expect(client.ping.query()).resolves.toBe("pong");

    const pingRequest = capturedRequests.find((request) =>
      request.url.includes("ping"),
    );
    expect(pingRequest?.headers.get("trpc-accept")).toBe("application/jsonl");
  });
});

describe("tRPC request boundaries", () => {
  const invoke = (req: Request) =>
    handleTrpcFetchRequest({
      endpoint: "/api/trpc",
      req,
      router: transportTestRouter,
    });
  it("rejects cross-origin and originless POSTs before executing procedures", async () => {
    for (const origin of [undefined, "http://sibling.localhost"]) {
      const response = await invoke(
        new Request("http://localhost/api/trpc/resolveRefs", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(origin ? { origin } : {}),
          },
          body: "{}",
        }),
      );
      expect(response.status).toBe(403);
    }
  });
  it("rejects simple form bodies", async () => {
    const response = await invoke(
      new Request("http://localhost/api/trpc/resolveRefs", {
        method: "POST",
        headers: { origin: "http://localhost" },
        body: new FormData(),
      }),
    );
    expect(response.status).toBe(415);
  });
  it("bounds streamed request bytes without trusting Content-Length", async () => {
    const response = await invoke(
      new Request("http://localhost/api/trpc/resolveRefs", {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
          "content-length": "2",
        },
        body: "x".repeat(16 * 1024 * 1024 + 1),
      }),
    );
    expect(response.status).toBe(413);
  });
  it("rejects oversized batches", async () => {
    const response = await invoke(
      new Request(
        "http://localhost/api/trpc/" +
          Array(21).fill("resolveRefs").join(",") +
          "?batch=1",
        {
          method: "POST",
          headers: {
            origin: "http://localhost",
            "content-type": "application/json",
          },
          body: JSON.stringify(
            Object.fromEntries(
              Array.from({ length: 21 }, (_, i) => [
                String(i),
                { json: { ids: [] } },
              ]),
            ),
          ),
        },
      ),
    );
    expect(response.status).toBe(400);
  });
});
