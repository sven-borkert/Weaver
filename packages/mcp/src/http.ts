import { createHash, randomUUID } from "node:crypto";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  isLegacyRequest,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import type { BearerVerifiers } from "@weaver/auth";
import { mcpToolByName } from "@weaver/assistant-tools/registry";
import {
  MCP_TOOLSETS_HEADER,
  parseToolsets,
  type McpToolsetName,
} from "@weaver/assistant-tools/toolsetNames";
import { withDiagnosticContext } from "@weaver/core/diagnostics/context";
import { EXTERNAL_TOOL_PREFIX } from "@weaver/core/externalMcp/inboundTools";
import type {
  ExternalRuntimeDeps,
  InboundExternalTool,
} from "@weaver/core/externalMcp/types";
import { hasCapability } from "@weaver/core/security/context";
import type { EncryptionKeyRing } from "@weaver/core/security/encryption";
import {
  createSlidingWindowLimiter,
  type RateLimitDecision,
} from "@weaver/core/security/rateLimit";
import {
  callInboundExternalTool,
  listInboundExternalTools,
} from "@weaver/core/services/externalMcp";
import { recordMcpAudit } from "@weaver/core/services/mcpOperations";
import type { PrismaClient } from "@weaver/db/client";
import type { McpRuntimeConfig } from "./config";
import { authenticate, MCP_SCOPES, principalFromAuthInfo } from "./gate";
import { innerToolArguments, innerToolName, isMetaToolName } from "./metaTools";
import { emitMcpResourceDiagnostic, parseWeaverUri } from "./resources";
import { DPOP_ALGS, jsonRpcError, withRequestId } from "./responses";
import {
  claimMcpAudit,
  createWeaverMcpServer,
  type AdminRuntimeFacts,
  type McpAuditState,
} from "./server";
import {
  emitMcpToolDiagnostic,
  UUID_RE,
  validatedToolMetadata,
  type ValidatedToolMetadata,
} from "./tools";

export type McpLogLine = Record<string, string | number | boolean | null>;

export type McpHttpDeps = {
  db: PrismaClient;
  verifiers: BearerVerifiers;
  config: McpRuntimeConfig;
  runtimeFacts?: AdminRuntimeFacts;
  ring?: EncryptionKeyRing | null;
  llmFetch?: typeof fetch;
  external?: ExternalRuntimeDeps | null;
  /** Structured, secret-free log sink; defaults to one JSON line on stdout. */
  log?: (line: McpLogLine) => void;
  /** Keys each limiter tracks before refusing new ones; tests lower it. */
  limiterMaxKeys?: number;
};

export type McpHttpHandlerLike = {
  fetch(
    request: Request,
    context?: { clientAddress?: string },
  ): Promise<Response>;
  /** Stops admission and drains accepted work; the runtime lifecycle owns the hard deadline. */
  close(): Promise<void>;
};

const MINUTE_MS = 60_000;
const SOURCE_ADMISSION_MULTIPLIER = 5;

export function protectedResourceMetadata(config: McpRuntimeConfig) {
  return {
    resource: config.resourceUrl,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [...MCP_SCOPES],
    resource_name: "Weaver MCP",
    dpop_signing_alg_values_supported: DPOP_ALGS.split(" "),
  };
}

function isJsonContentType(value: string | null): boolean {
  return /^application\/json(\s*;.*)?$/i.test((value ?? "").trim());
}

async function readBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    return { ok: false };
  }
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}

function credentialFreeHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("dpop");
  return headers;
}

function protocolRequest(
  request: Request,
  body: string,
  shieldTransportAbort: boolean,
): Request {
  return new Request(request.url, {
    method: request.method,
    headers: credentialFreeHeaders(request),
    body,
    ...(shieldTransportAbort ? {} : { signal: request.signal }),
  });
}

type AuditedRequest = {
  method: "tools/call" | "resources/read";
  name: string;
  projectId: string | null;
  args?: unknown;
};

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function auditedRequest(body: unknown): AuditedRequest | undefined {
  const message = recordOf(body);
  const method = message?.method;
  if (method !== "tools/call" && method !== "resources/read") return;
  const params = recordOf(message?.params);
  if (method === "tools/call") {
    const args = params?.arguments;
    const record = recordOf(args);
    const name = typeof params?.name === "string" ? params.name : "(invalid)";
    const projectId = name.startsWith(EXTERNAL_TOOL_PREFIX)
      ? null
      : record?.projectId;
    return {
      method,
      name,
      projectId:
        typeof projectId === "string" && UUID_RE.test(projectId)
          ? projectId
          : null,
      args,
    };
  }
  const uri = typeof params?.uri === "string" ? params.uri : "(invalid)";
  const projectId = parseWeaverUri(uri)?.projectId ?? null;
  return { method, name: uri, projectId };
}

function recognizedMethod(body: unknown): string {
  const method = recordOf(body)?.method;
  return typeof method === "string" &&
    new Set([
      "initialize",
      "ping",
      "server/discover",
      "tools/list",
      "tools/call",
      "resources/list",
      "resources/templates/list",
      "resources/read",
      "notifications/initialized",
      "notifications/cancelled",
    ]).has(method)
    ? method
    : "(invalid)";
}

function toolErrorResponse(
  body: unknown,
  code: "NOT_FOUND" | "BAD_REQUEST" | "CANCELLED",
  message: string,
): Response {
  const id = recordOf(body)?.id;
  const error = { code, message };
  return Response.json({
    jsonrpc: "2.0",
    ...(typeof id === "string" || typeof id === "number" ? { id } : {}),
    result: {
      resultType: "complete",
      isError: true,
      content: [{ type: "text", text: `${code}: ${message}` }],
      structuredContent: { error },
    },
  });
}

export function createMcpHttpHandler(deps: McpHttpDeps): McpHttpHandlerLike {
  const { config } = deps;
  const log =
    deps.log ?? ((line: McpLogLine) => console.log(JSON.stringify(line)));
  const metadataUrl = `${new URL(config.resourceUrl).origin}${config.metadataPath}`;
  const maxKeys = deps.limiterMaxKeys;
  const limiter = createSlidingWindowLimiter({
    limit: config.rateLimitPerMinute,
    windowMs: MINUTE_MS,
    maxKeys,
  });
  const anonLimiter = createSlidingWindowLimiter({
    limit: config.anonRateLimitPerMinute,
    windowMs: MINUTE_MS,
    maxKeys,
  });
  // Charged before an unverified header can pick its own bucket; the multiple
  // leaves headroom for several clients behind one proxy or NAT address.
  const sourceLimiter = createSlidingWindowLimiter({
    limit: config.anonRateLimitPerMinute * SOURCE_ADMISSION_MULTIPLIER,
    windowMs: MINUTE_MS,
    maxKeys,
  });
  const knownCredentials = new Map<string, number>();
  const admissionLimiter = createSlidingWindowLimiter({
    limit: config.rateLimitPerMinute * 2,
    windowMs: MINUTE_MS,
    maxKeys,
  });
  const auditStates = new Map<string, McpAuditState>();
  const writeRequestSignals = new Map<string, AbortSignal>();
  const externalToolsByRequest = new Map<
    string,
    readonly InboundExternalTool[]
  >();
  const toolsetsByRequest = new Map<string, readonly McpToolsetName[]>();
  const toolCallRequests = new Set<string>();
  const gate = {
    db: deps.db,
    verifiers: deps.verifiers,
    resourceUrl: config.resourceUrl,
    metadataUrl,
  };
  // One fresh McpServer per request; the factory only ever sees a token-free AuthInfo.
  const handler = createMcpHandler(
    (ctx) => {
      const principal = principalFromAuthInfo(ctx.authInfo);
      const requestId =
        typeof ctx.authInfo?.extra?.requestId === "string"
          ? ctx.authInfo.extra.requestId
          : randomUUID();
      return createWeaverMcpServer({
        db: deps.db,
        principal,
        requestId,
        config,
        runtimeFacts: deps.runtimeFacts,
        llm: {
          ring: deps.ring ?? null,
          fetchImpl: deps.llmFetch ?? fetch,
        },
        external: deps.external ?? undefined,
        auditState: auditStates.get(requestId),
        writeRequestSignal: writeRequestSignals.get(requestId),
        externalTools: externalToolsByRequest.get(requestId),
        toolsets: toolsetsByRequest.get(requestId),
        registerUnlisted: toolCallRequests.has(requestId),
        callExternal: deps.external
          ? (input) =>
              callInboundExternalTool(deps.external!, principal.security, {
                ...input,
                requestId,
                timeoutMs: config.toolTimeoutMs,
              })
          : undefined,
      });
    },
    {
      legacy: "stateless",
      onerror: (error) =>
        log({ level: "error", event: "mcp.handler", error: error.name }),
    },
  );

  const base: McpHttpHandlerLike = {
    async fetch(request, context) {
      const requestId = randomUUID();
      const started = Date.now();
      const url = new URL(request.url);
      const respond = (response: Response) =>
        withRequestId(response, requestId);

      if (url.pathname === "/health") {
        return respond(
          Response.json({
            status: "ok",
            runtime: "mcp-server",
            version: config.version,
          }),
        );
      }
      if (url.pathname === config.metadataPath) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return respond(
            jsonRpcError(405, -32600, "method not allowed", { allow: "GET" }),
          );
        }
        return respond(Response.json(protectedResourceMetadata(config)));
      }
      if (url.pathname !== config.mcpPath) {
        return respond(jsonRpcError(404, -32601, "not found"));
      }
      const validationHeaders = credentialFreeHeaders(request);
      validationHeaders.set("host", validationHeaders.get("host") ?? url.host);
      const validationRequest = new Request(request.url, {
        headers: validationHeaders,
      });
      const rejected =
        hostHeaderValidationResponse(validationRequest, config.allowedHosts) ??
        originValidationResponse(validationRequest, config.allowedOrigins);
      if (rejected) return respond(rejected);
      if (request.method !== "POST") {
        return respond(
          jsonRpcError(405, -32600, "method not allowed", { allow: "POST" }),
        );
      }
      if (!isJsonContentType(request.headers.get("content-type"))) {
        return respond(
          jsonRpcError(415, -32600, "content type must be application/json"),
        );
      }
      const authorization = request.headers.get("authorization") ?? "";
      const credentialHash = createHash("sha256")
        .update(authorization)
        .digest("hex");
      const known = (knownCredentials.get(credentialHash) ?? 0) > Date.now();
      const source = context?.clientAddress ?? "direct";
      let admission: RateLimitDecision;
      if (known) admission = admissionLimiter.check(credentialHash);
      else {
        admission = sourceLimiter.check(`source:${source}`);
        // An unrecognised header gets no bucket of its own: one key per fake
        // token would let a flood fill the limiter and deny a real key's first use.
        if (admission.allowed && !authorization)
          admission = anonLimiter.check(`${source}:missing`);
      }
      if (!admission.allowed) {
        return respond(
          jsonRpcError(429, -32000, "rate limit exceeded", {
            "retry-after": String(admission.retryAfterSeconds),
          }),
        );
      }
      const body = await readBody(request, config.maxBodyBytes);
      if (!body.ok)
        return respond(jsonRpcError(413, -32600, "request body too large"));

      const auth = await authenticate(gate, request, requestId);
      if (!auth.ok) {
        knownCredentials.delete(credentialHash);
        log({
          level: "warn",
          event: "mcp.denied",
          requestId,
          reason: auth.reason,
          status: auth.response.status,
        });
        return respond(auth.response);
      }
      // Recognition changes admission only; every request still revalidates live authority.
      knownCredentials.delete(credentialHash);
      if (knownCredentials.size >= 10_000)
        knownCredentials.delete(knownCredentials.keys().next().value!);
      knownCredentials.set(credentialHash, Date.now() + MINUTE_MS);
      const { security } = auth.principal;
      const toolsets = parseToolsets(request.headers.get(MCP_TOOLSETS_HEADER));
      const diagnosticContext = {
        requestId,
        userId: security.userId,
        credentialId: security.credentialId,
      };
      let parsedBody: unknown;
      let parseFailed = false;
      try {
        parsedBody = JSON.parse(body.text);
      } catch {
        parseFailed = true;
      }
      if (
        !parseFailed &&
        parsedBody &&
        typeof parsedBody === "object" &&
        "method" in parsedBody &&
        parsedBody.method === "subscriptions/listen"
      )
        return respond(
          jsonRpcError(400, -32601, "subscriptions are not supported"),
        );
      const target = parseFailed ? undefined : auditedRequest(parsedBody);
      const isToolCall = target?.method === "tools/call";
      // call_tool is shielded, rate-limit audited and resolved like its inner tool.
      const innerName =
        isToolCall && target.name === "call_tool"
          ? innerToolName(target.args)
          : null;
      const effectiveName = innerName ?? target?.name ?? "";
      const targetArgs = innerName
        ? innerToolArguments(target?.args)
        : target?.args;
      const namedContract = isToolCall
        ? mcpToolByName(effectiveName)
        : undefined;
      // A forbidden inner tool must read exactly like an unknown one.
      const targetContract =
        innerName &&
        namedContract &&
        !hasCapability(security, namedContract.capability)
          ? undefined
          : namedContract;
      const targetMeta = isToolCall && isMetaToolName(target.name);
      const auditState: McpAuditState = { claimed: false };
      const limitKey =
        security.authenticationMethod === "apiKey"
          ? `key:${security.credentialId}`
          : `oauth:${security.userId}:${auth.principal.clientId ?? ""}`;
      const decision = limiter.check(limitKey);
      if (!decision.allowed) {
        if (target && claimMcpAudit(auditState)) {
          const metadata = targetContract
            ? await validatedToolMetadata(targetContract, targetArgs ?? {})
            : undefined;
          await recordMcpAudit(deps.db, {
            requestId,
            userId: security.userId,
            credentialId: security.credentialId,
            authenticationMethod: security.authenticationMethod,
            clientId: auth.principal.clientId,
            method: target.method,
            name: targetContract?.name ?? target.name,
            projectId:
              target.method === "tools/call"
                ? (metadata?.projectId ?? null)
                : target.projectId,
            outcome: "denied",
            errorCode: "RATE_LIMITED",
            durationMs: Date.now() - started,
            commitSha: null,
          });
          if (target.method === "tools/call") {
            withDiagnosticContext(diagnosticContext, () =>
              emitMcpToolDiagnostic({
                contract: targetContract,
                toolName:
                  targetMeta && !targetContract ? target.name : undefined,
                toolKind: "meta",
                outcome: "denied",
                errorCode: "RATE_LIMITED",
                durationMs: Date.now() - started,
                metadata,
                via: innerName && targetContract ? "call_tool" : undefined,
              }),
            );
          } else {
            withDiagnosticContext(diagnosticContext, () =>
              emitMcpResourceDiagnostic({
                ref: parseWeaverUri(target.name),
                outcome: "denied",
                errorCode: "RATE_LIMITED",
                durationMs: Date.now() - started,
              }),
            );
          }
        }
        return respond(
          jsonRpcError(429, -32000, "rate limit exceeded", {
            "retry-after": String(decision.retryAfterSeconds),
          }),
        );
      }
      if (parseFailed) {
        return respond(jsonRpcError(400, -32700, "parse error"));
      }
      if (Array.isArray(parsedBody)) {
        return respond(
          jsonRpcError(400, -32600, "batch requests are not supported"),
        );
      }
      const wantsExternal =
        !!deps.external &&
        hasCapability(security, "external:use") &&
        ((recordOf(parsedBody)?.method === "tools/list" &&
          toolsets.includes("external")) ||
          (isToolCall &&
            (effectiveName.startsWith(EXTERNAL_TOOL_PREFIX) || targetMeta)));
      const externalTools = wantsExternal
        ? await listInboundExternalTools(
            { db: deps.db, now: deps.external!.now },
            security,
          )
        : [];
      const targetExternal = isToolCall
        ? externalTools.find((tool) => tool.name === effectiveName)
        : undefined;
      const via =
        innerName && (targetContract || targetExternal)
          ? ("call_tool" as const)
          : undefined;
      externalToolsByRequest.set(requestId, externalTools);
      toolsetsByRequest.set(requestId, toolsets);
      if (isToolCall) toolCallRequests.add(requestId);
      auditStates.set(requestId, auditState);
      const shieldWriteTransport =
        (targetContract?.kind === "write" &&
          hasCapability(security, targetContract.capability)) ||
        targetExternal?.effect === "write";
      // Write aborts stay cooperative so SDK teardown cannot outrun a commit.
      if (shieldWriteTransport) {
        writeRequestSignals.set(requestId, request.signal);
      }
      let response: Response;
      try {
        const sdkRequest = protocolRequest(
          request,
          body.text,
          shieldWriteTransport,
        );
        const legacy = await isLegacyRequest(sdkRequest, parsedBody);
        response = await withDiagnosticContext(diagnosticContext, () =>
          handler.fetch(sdkRequest, {
            authInfo: auth.authInfo,
            parsedBody,
          }),
        );
        if (
          legacy &&
          response.headers.get("content-type")?.includes("text/event-stream")
        ) {
          // Legacy SSE opens before execution; finish it before auditing or releasing shutdown admission.
          const completedBody = await response.arrayBuffer();
          response =
            !shieldWriteTransport &&
            request.signal.aborted &&
            !/^data:/m.test(new TextDecoder().decode(completedBody))
              ? new Response(null, { status: 499 })
              : new Response(completedBody, response);
        }
        if (target && !auditState.claimed) {
          let errorCode = "BAD_REQUEST";
          let outcome: "error" | "denied" = "error";
          let toolMetadata: ValidatedToolMetadata | undefined;
          let stable: Response | undefined;
          if (response.status === 499) {
            errorCode = "CANCELLED";
            if (target.method === "tools/call")
              stable = toolErrorResponse(
                parsedBody,
                "CANCELLED",
                "tool cancelled",
              );
          } else if (target.method === "tools/call") {
            const contract = targetContract;
            if (targetMeta && !contract && !targetExternal) {
              errorCode = "BAD_REQUEST";
              if (response.status === 200)
                stable = toolErrorResponse(
                  parsedBody,
                  "BAD_REQUEST",
                  "invalid tool arguments",
                );
            } else if (!contract && targetExternal) {
              errorCode = "BAD_REQUEST";
              if (response.status === 200)
                stable = toolErrorResponse(
                  parsedBody,
                  "BAD_REQUEST",
                  "invalid tool arguments",
                );
            } else if (!contract) {
              errorCode = "NOT_FOUND";
              if (response.status === 200)
                stable = toolErrorResponse(
                  parsedBody,
                  "NOT_FOUND",
                  "not found or not accessible",
                );
            } else if (!hasCapability(security, contract.capability)) {
              outcome = "denied";
              errorCode = "FORBIDDEN";
              if (response.status === 200)
                stable = toolErrorResponse(
                  parsedBody,
                  "NOT_FOUND",
                  "not found or not accessible",
                );
            } else {
              toolMetadata = await validatedToolMetadata(
                contract,
                targetArgs ?? {},
              );
              // Valid inner arguments here mean the SDK rejected call_tool's own input.
              if (
                (!toolMetadata.valid || targetMeta) &&
                response.status === 200
              ) {
                stable = toolErrorResponse(
                  parsedBody,
                  "BAD_REQUEST",
                  "invalid tool arguments",
                );
              }
            }
          } else if (!parseWeaverUri(target.name)) {
            errorCode = "NOT_FOUND";
          }
          if (
            target.method === "tools/call" &&
            targetContract &&
            !toolMetadata
          ) {
            toolMetadata = await validatedToolMetadata(
              targetContract,
              targetArgs ?? {},
            );
          }
          if (claimMcpAudit(auditState)) {
            await recordMcpAudit(deps.db, {
              requestId,
              userId: security.userId,
              credentialId: security.credentialId,
              authenticationMethod: security.authenticationMethod,
              clientId: auth.principal.clientId,
              method: target.method,
              name: targetContract?.name ?? targetExternal?.name ?? target.name,
              projectId:
                target.method === "tools/call" && !targetExternal
                  ? (toolMetadata?.projectId ?? null)
                  : target.projectId,
              outcome,
              errorCode,
              durationMs: Date.now() - started,
              commitSha: null,
            });
            if (target.method === "tools/call") {
              withDiagnosticContext(diagnosticContext, () =>
                emitMcpToolDiagnostic({
                  contract: targetContract,
                  toolName:
                    targetExternal?.name ??
                    (targetMeta ? target.name : undefined),
                  toolKind: targetExternal ? "external" : "meta",
                  outcome,
                  errorCode,
                  durationMs: Date.now() - started,
                  metadata: toolMetadata,
                  via,
                }),
              );
            } else {
              withDiagnosticContext(diagnosticContext, () =>
                emitMcpResourceDiagnostic({
                  ref: parseWeaverUri(target.name),
                  outcome,
                  errorCode,
                  durationMs: Date.now() - started,
                }),
              );
            }
            response = stable ?? response;
          }
        }
        if (target?.method === "tools/call" && response.status === 499) {
          response = toolErrorResponse(
            parsedBody,
            "CANCELLED",
            "tool cancelled",
          );
        }
      } finally {
        auditStates.delete(requestId);
        writeRequestSignals.delete(requestId);
        externalToolsByRequest.delete(requestId);
        toolsetsByRequest.delete(requestId);
        toolCallRequests.delete(requestId);
      }
      log({
        level: "info",
        event: "mcp.request",
        requestId,
        method: recognizedMethod(parsedBody),
        name:
          targetContract?.name ??
          targetExternal?.name ??
          (targetMeta ? target.name : null),
        status: response.status,
        userId: security.userId,
        credentialId: security.credentialId,
        authenticationMethod: security.authenticationMethod,
        durationMs: Date.now() - started,
      });
      return respond(response);
    },
    close: () => handler.close(),
  };
  let accepting = true;
  const inFlight = new Set<Promise<void>>();
  let closePromise: Promise<void> | undefined;

  return {
    fetch(request, context) {
      if (!accepting) {
        return Promise.resolve(
          withRequestId(
            jsonRpcError(503, -32000, "server shutting down"),
            randomUUID(),
          ),
        );
      }
      let finish: () => void = () => undefined;
      const active = new Promise<void>((resolve) => {
        finish = resolve;
      });
      inFlight.add(active);
      return base.fetch(request, context).finally(() => {
        inFlight.delete(active);
        finish();
      });
    },
    close() {
      accepting = false;
      return (closePromise ??= (async () => {
        await Promise.all([...inFlight]);
        await base.close();
      })());
    },
  };
}
