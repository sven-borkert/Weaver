import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export async function createWorkerHealthServer(
  port: number,
  host = "127.0.0.1",
  isReady: () => boolean = () => true,
  options: {
    roles?: readonly string[];
    checkDependencies?: () => Promise<boolean>;
  } = {},
) {
  const roles = options.roles ?? [];
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.url !== "/health" && request.url !== "/ready") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    if (!isReady()) {
      response.writeHead(503).end(
        JSON.stringify({
          status: "starting",
          runtime: "agent-worker",
          roles,
        }),
      );
      return;
    }
    if (
      request.url === "/ready" &&
      options.checkDependencies &&
      !(await options.checkDependencies().catch(() => false))
    ) {
      response.writeHead(503).end(
        JSON.stringify({
          status: "unavailable",
          runtime: "agent-worker",
          roles,
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({ status: "ok", runtime: "agent-worker", roles }),
    );
  };
  const server = createServer((request, response) => {
    void serve(request, response).catch(() => response.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("worker health bind failed");
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
