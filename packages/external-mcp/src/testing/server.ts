import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";

export type FixtureOptions = {
  protocolVersion?: string;
  responseMode?: "json" | "sse";
  requireSession?: boolean;
  toolCount?: number;
  tools?: unknown[];
  pageSize?: number;
  cyclicCursor?: boolean;
  mode?: "401" | "redirect" | "overflow" | "timeout" | "invalid-json";
  redirectTo?: string;
  onCall?: (name: string, args: Record<string, unknown>) => unknown;
  tls?: { cert: string; key: string };
};

export async function startMcpFixture(options: FixtureOptions = {}) {
  let counter = 0;
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const requests: {
    method: string;
    path: string;
    rpcMethod?: string;
    session?: string;
    protocolVersion?: string;
  }[] = [];
  function requestHandler(req: IncomingMessage, res: ServerResponse) {
    void handle().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    async function handle() {
      const record = {
        method: req.method ?? "",
        path: req.url ?? "",
        session: req.headers["mcp-session-id"] as string | undefined,
        protocolVersion: req.headers["mcp-protocol-version"] as
          string | undefined,
        rpcMethod: undefined as string | undefined,
      };
      requests.push(record);
      if (options.mode === "401") {
        res.writeHead(401).end();
        return;
      }
      if (options.mode === "redirect") {
        res.writeHead(307, { location: options.redirectTo ?? "/mcp" }).end();
        return;
      }
      if (req.method === "GET") {
        res.writeHead(405).end();
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += String(chunk);
      const message = JSON.parse(body) as {
        id?: number;
        method: string;
        params?: {
          cursor?: string;
          name?: string;
          arguments?: Record<string, unknown>;
        };
      };
      record.rpcMethod = message.method;
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      if (options.mode === "timeout") return;
      if (options.mode === "invalid-json") {
        res.writeHead(200, { "content-type": "application/json" }).end("{");
        return;
      }
      if (options.mode === "overflow") {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('"');
        res.end("x".repeat(3 * 1024 * 1024));
        return;
      }
      if (
        options.requireSession &&
        message.method !== "initialize" &&
        record.session !== "fixture-session"
      ) {
        res.writeHead(400).end();
        return;
      }
      let result: unknown;
      if (message.method === "initialize") {
        result = {
          protocolVersion: options.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "synthetic-counter", version: "1" },
        };
        if (options.requireSession)
          res.setHeader("mcp-session-id", "fixture-session");
      } else if (message.method === "tools/list") {
        const count = options.tools?.length ?? options.toolCount ?? 2;
        const start = Number(message.params?.cursor ?? 0);
        const end = Math.min(count, start + (options.pageSize ?? count));
        result = {
          tools: Array.from({ length: end - start }, (_, j) => {
            const i = start + j;
            if (options.tools) return options.tools[i];
            return {
              name:
                i === 0
                  ? "read_counter"
                  : i === 1
                    ? "set_counter"
                    : `synthetic_${i}`,
              inputSchema: {
                type: "object",
                properties: i === 1 ? { value: { type: "number" } } : {},
                ...(i === 1 ? { required: ["value"] } : {}),
                additionalProperties: false,
              },
            };
          }),
          ...(options.cyclicCursor
            ? { nextCursor: "0" }
            : end < count
              ? { nextCursor: String(end) }
              : {}),
        };
      } else if (message.method === "resources/list")
        result = { resources: [] };
      else if (message.method === "tools/call") {
        const name = message.params?.name ?? "";
        const args = message.params?.arguments ?? {};
        calls.push({ name, arguments: args });
        if (name === "set_counter") counter = Number(args.value);
        result = options.onCall
          ? await options.onCall(name, args)
          : {
              content: [{ type: "text", text: String(counter) }],
              structuredContent: { counter },
              isError: false,
            };
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Unsupported method" },
          }),
        );
        return;
      }
      const json = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
      res.writeHead(200, {
        "content-type":
          options.responseMode === "sse"
            ? "text/event-stream"
            : "application/json",
      });
      res.end(
        options.responseMode === "sse"
          ? `event: message\ndata: ${json}\n\n`
          : json,
      );
    }
  }
  const server = options.tls
    ? createHttpsServer(options.tls, requestHandler)
    : createHttpServer(requestHandler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture address");
  return {
    url: `${options.tls ? "https" : "http"}://127.0.0.1:${address.port}/mcp`,
    calls,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
