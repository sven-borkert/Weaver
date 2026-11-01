import { createServer } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { McpHttpHandlerLike } from "./http";

export type McpNodeServer = {
  port: number;
  /** Stops listening, drains requests, then closes the SDK handler. */
  close(): Promise<void>;
};

/** Serves the fetch-shaped handler over node:http; streaming (SSE) responses are handled by the adapter. */
export async function createMcpNodeServer(
  handler: McpHttpHandlerLike,
  options: {
    port: number;
    host: string;
    onError?: (error: Error) => void;
    /** Trust the direct-client X-Forwarded-For hop only from a controlled proxy. */
    trustProxy?: boolean;
  },
): Promise<McpNodeServer> {
  let closing = false;
  const server = createServer((request, response) => {
    if (closing) {
      response.writeHead(503, {
        connection: "close",
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "server shutting down" },
        }),
      );
      return;
    }
    const socketAddress = request.socket.remoteAddress?.replace(/^::ffff:/, "");
    const forwarded = request.headers["x-forwarded-for"];
    // A trusted single proxy appends the direct client address as the right-most hop.
    const directClient = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      ?.split(",")
      .at(-1)
      ?.trim();
    const clientAddress =
      options.trustProxy && directClient ? directClient : socketAddress;
    const node = toNodeHandler(
      {
        fetch: (webRequest) => handler.fetch(webRequest, { clientAddress }),
      },
      { onerror: options.onError },
    );
    void node(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("mcp-server bind failed");
  let closePromise: Promise<void> | undefined;
  return {
    port: address.port,
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await handler.close();
      })();
      return closePromise;
    },
  };
}
