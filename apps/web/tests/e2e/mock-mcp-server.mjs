import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export const MCP_FIXTURE_TOOLS = [
  {
    name: "read_counter",
    description: "Read the synthetic E2E counter (read_counter).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "set_counter",
    description: "Set the synthetic E2E counter (set_counter).",
    inputSchema: {
      type: "object",
      properties: { value: { type: "integer" } },
      required: ["value"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
];

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function createMockMcpServer() {
  let counter = 0;
  let reads = 0;
  let writes = 0;
  let disconnectNextWrite = false;
  return createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && path === "/health")
      return json(response, 200, { status: "ok" });
    if (request.method === "GET" && path === "/__fixture/state")
      return json(response, 200, {
        counter,
        reads,
        writes,
        disconnectNextWrite,
      });
    if (
      request.method !== "POST" ||
      !["/mcp", "/__fixture/control"].includes(path)
    )
      return json(response, 404, { error: "Not found" });
    let body;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 65536) return json(response, 413, { error: "Too large" });
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return json(response, 400, { error: "Invalid JSON" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return json(response, 400, { error: "Expected an object" });
    if (path === "/__fixture/control") {
      if (body.action === "reset") {
        counter = 0;
        reads = 0;
        writes = 0;
        disconnectNextWrite = false;
      } else if (body.action === "disconnect_next_write") {
        disconnectNextWrite = true;
      } else return json(response, 400, { error: "Unknown control action" });
      return json(response, 200, {
        counter,
        reads,
        writes,
        disconnectNextWrite,
      });
    }
    const result = (value) =>
      json(response, 200, { jsonrpc: "2.0", id: body.id, result: value });
    const error = (code, message) =>
      json(response, 200, {
        jsonrpc: "2.0",
        id: body.id,
        error: { code, message },
      });
    if (body.method === "notifications/initialized") {
      response.writeHead(202);
      return response.end();
    }
    if (body.method === "initialize")
      return result({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "weaver-e2e-counter", version: "1.0.0" },
      });
    if (body.method === "tools/list")
      return result({ tools: MCP_FIXTURE_TOOLS });
    if (body.method === "resources/list") return result({ resources: [] });
    if (body.method === "ping") return result({});
    if (body.method !== "tools/call") return error(-32601, "Method not found");
    if (body.params?.name === "read_counter") {
      reads++;
    } else if (
      body.params?.name === "set_counter" &&
      Number.isSafeInteger(body.params.arguments?.value)
    ) {
      counter = body.params.arguments.value;
      writes++;
      if (disconnectNextWrite) {
        disconnectNextWrite = false;
        return response.destroy();
      }
    } else return error(-32602, "Invalid tool or arguments");
    return result({
      content: [{ type: "text", text: JSON.stringify({ counter }) }],
      isError: false,
    });
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  const server = createMockMcpServer();
  server.listen(
    Number(process.env.WEAVER_E2E_EXTERNAL_MCP_PORT ?? "4011"),
    "127.0.0.1",
  );
  const close = () => server.close(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
