import { createPinnedFetch } from "@weaver/config/outboundFetch";
import {
  Client,
  SUPPORTED_PROTOCOL_VERSIONS,
  SdkError,
  SdkErrorCode,
  UnsupportedProtocolVersionError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { ExternalMcpError } from "./errors";
import { createBoundedFetch, endpointUrl } from "./http";
import {
  isObject,
  jsonBytes,
  parseToolDefinitions,
  validateArguments,
  validateOutput,
} from "./schemas";
import type {
  ExternalMcpTransport,
  JsonObject,
  JsonValue,
  RemoteCatalog,
} from "./types";

export function createExternalMcpTransport({
  fetchImpl,
}: {
  fetchImpl: typeof fetch;
}): ExternalMcpTransport {
  return {
    async open(options) {
      const timeoutMs = options.timeoutMs ?? 30000;
      if (
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 5000 ||
        timeoutMs > 120000
      )
        throw new ExternalMcpError("INVALID_ARGUMENTS");
      const controller = new AbortController();
      const signal = AbortSignal.any([options.signal, controller.signal]);
      const guardedFetch = createPinnedFetch(fetchImpl, {
        rejectUnauthorized: !options.insecureTls,
      });
      const http = createBoundedFetch({
        ...options,
        signal,
        fetchImpl: guardedFetch,
      });
      const client = new Client(
        { name: "weaver-external-mcp", version: "1" },
        {
          capabilities: {},
          inputRequired: { autoFulfill: false },
          versionNegotiation: { mode: "legacy" },
          listMaxPages: 20,
        },
      );
      const transport = new StreamableHTTPClientTransport(
        endpointUrl(options.endpoint),
        {
          fetch: http.fetch,
          onInsufficientScope: "throw",
          reconnectionOptions: {
            maxRetries: 0,
            maxReconnectionDelay: 0,
            initialReconnectionDelay: 0,
            reconnectionDelayGrowFactor: 1,
          },
        },
      );
      let unsupportedProtocol = false;
      let initializeId: string | number | undefined;
      const send = transport.send.bind(transport);
      transport.send = async (message, options) => {
        if (
          "method" in message &&
          message.method === "initialize" &&
          "id" in message
        )
          initializeId = message.id;
        return send(message, options);
      };
      let receive: typeof transport.onmessage;
      Object.defineProperty(transport, "onmessage", {
        configurable: true,
        get: () => receive,
        set: (handler: typeof transport.onmessage) => {
          receive = handler
            ? (message) => {
                if (
                  "result" in message &&
                  message.id === initializeId &&
                  typeof message.result.protocolVersion === "string" &&
                  !SUPPORTED_PROTOCOL_VERSIONS.filter(
                    (v) => v < "2026-07-28",
                  ).includes(message.result.protocolVersion)
                )
                  unsupportedProtocol = true;
                handler(message);
              }
            : undefined;
        },
      });
      let closed = false;
      let busy = false;
      let catalog: RemoteCatalog | undefined;
      async function run<T>(
        operation: (requestSignal: AbortSignal) => Promise<T>,
      ) {
        if (closed) throw new ExternalMcpError("CLOSED");
        if (busy) throw new ExternalMcpError("BUSY");
        busy = true;
        const requestSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(timeoutMs),
        ]);
        http.setSignal(requestSignal);
        try {
          requestSignal.throwIfAborted();
          return await operation(requestSignal);
        } catch (error) {
          if (error instanceof ExternalMcpError) throw error;
          if (
            error instanceof SdkError &&
            error.code === SdkErrorCode.InvalidResult
          )
            throw new ExternalMcpError("INVALID_RESULT");
          if (
            error instanceof SdkError &&
            error.code === SdkErrorCode.RequestTimeout
          )
            throw new ExternalMcpError("CANCELLED");
          if (
            unsupportedProtocol ||
            error instanceof UnsupportedProtocolVersionError ||
            (error instanceof SdkError &&
              error.code === SdkErrorCode.EraNegotiationFailed)
          )
            throw new ExternalMcpError("UNSUPPORTED_PROTOCOL");
          throw requestSignal.aborted
            ? new ExternalMcpError("CANCELLED")
            : new ExternalMcpError("TRANSPORT_ERROR", { cause: error });
        } finally {
          busy = false;
        }
      }
      try {
        await run((signal) =>
          client.connect(transport, { signal, timeout: timeoutMs }),
        );
      } catch (error) {
        controller.abort();
        await client.close();
        throw error;
      }
      async function discover(): Promise<RemoteCatalog> {
        return run(async (signal) => {
          catalog = undefined;
          http.reset(2 * 1024 * 1024);
          const tools: unknown[] = [];
          const resources: JsonObject[] = [];
          let pages = 0;
          for (const kind of ["tools", "resources"] as const) {
            if (
              kind === "resources" &&
              !client.getServerCapabilities()?.resources
            )
              continue;
            let cursor: string | undefined;
            const seen = new Set<string>();
            do {
              if (++pages > 20) throw new ExternalMcpError("INVALID_CATALOG");
              const params = cursor === undefined ? {} : { cursor };
              const requestOptions = { signal, timeout: timeoutMs };
              if (kind === "tools") {
                const page = await client.request(
                  { method: "tools/list", params },
                  requestOptions,
                );
                tools.push(...page.tools);
                if (tools.length > 500)
                  throw new ExternalMcpError("INVALID_CATALOG");
                cursor = page.nextCursor;
              } else {
                const page = await client.request(
                  { method: "resources/list", params },
                  requestOptions,
                );
                for (const resource of page.resources) {
                  if (
                    !isObject(resource) ||
                    jsonBytes(resource) > 65536 ||
                    resources.length >= 500
                  )
                    throw new ExternalMcpError("INVALID_CATALOG");
                  resources.push(resource);
                }
                cursor = page.nextCursor;
              }
              if (cursor !== undefined) {
                if (seen.has(cursor))
                  throw new ExternalMcpError("INVALID_CATALOG");
                seen.add(cursor);
              }
            } while (cursor !== undefined);
          }
          const serverInfo = client.getServerVersion();
          const protocolVersion = client.getNegotiatedProtocolVersion();
          if (!isObject(serverInfo) || !protocolVersion)
            throw new ExternalMcpError("INVALID_CATALOG");
          catalog = {
            canonicalEndpoint: http.canonicalEndpoint,
            serverInfo,
            protocolVersion,
            tools: parseToolDefinitions(tools),
            resources,
          };
          return structuredClone(catalog);
        });
      }
      return {
        discover,
        async call(input) {
          if (!catalog) await discover();
          return run(async (signal) => {
            const tool = catalog?.tools.find(
              (tool) => tool.name === input.name,
            );
            if (!tool) throw new ExternalMcpError("INVALID_ARGUMENTS");
            validateArguments(tool, input.arguments);
            http.reset(256 * 1024);
            const result = await client.callTool(input, {
              signal,
              timeout: timeoutMs,
            });
            if (!result.isError) validateOutput(tool, result.structuredContent);
            let remaining = 16000;
            let truncated = false;
            const content: JsonValue[] = [];
            for (const item of result.content) {
              if (item.type !== "text") {
                truncated = true;
                continue;
              }
              const text = item.text.slice(0, remaining);
              if (text.length < item.text.length) truncated = true;
              remaining -= text.length;
              if (text) content.push({ type: "text", text });
            }
            let structuredContent: JsonObject | undefined;
            if (result.structuredContent !== undefined) {
              if (!isObject(result.structuredContent))
                throw new ExternalMcpError("INVALID_RESULT");
              if (JSON.stringify(result.structuredContent).length <= remaining)
                structuredContent = result.structuredContent;
              else truncated = true;
            }
            return {
              isError: result.isError ?? false,
              content,
              ...(structuredContent ? { structuredContent } : {}),
              truncated,
              responseBytes: http.bytes,
            };
          });
        },
        async close() {
          if (closed) return;
          closed = true;
          controller.abort();
          await client.close();
        },
      };
    },
  };
}
