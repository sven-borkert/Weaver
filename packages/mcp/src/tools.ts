import type {
  CallToolResult,
  ContentBlock,
  McpServer,
  ResourceLink,
  ServerContext,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import {
  MAX_TOOL_OUTPUT_CHARS,
  toolErrorFromUnknown,
  truncatedToolOutput,
  type AnyToolContract,
  type ToolContext,
} from "@weaver/assistant-tools/contract";
import type { SourceLocator } from "@weaver/core/assistant/citations";
import { emitDiagnostic } from "@weaver/core/diagnostics/writer";
import { z } from "zod";
import { citationResource, RESOURCE_MIME, resourceUriFor } from "./resources";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ToolAuditEvent = {
  name: string;
  projectId: string | null;
  outcome: "ok" | "error" | "denied";
  errorCode: string | null;
  durationMs: number;
  commitSha: string | null;
};

export type ToolDeps = {
  /** Built lazily per request: scope resolution costs a query. */
  context: () => Promise<ToolContext>;
  toolTimeoutMs: number;
  /** Original HTTP abort, kept separate when a write shields SDK teardown. */
  writeRequestSignal?: AbortSignal;
  /** Returns true only for the callback that owns the request's audit slot. */
  onAudit: (event: ToolAuditEvent) => Promise<boolean>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Serialize-then-parse so the result is a JSON value: Prisma rows carry Dates,
 * and the client SDK validates structuredContent as JSON (the a4b5fae rule).
 */
export function jsonSafeOutput(output: unknown): {
  value: Record<string, unknown>;
  text: string;
} {
  const serialized = JSON.stringify(output) ?? "null";
  const parsed = JSON.parse(serialized) as unknown;
  const value = isRecord(parsed) ? parsed : { value: parsed };
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") <= MAX_TOOL_OUTPUT_CHARS)
    return { value, text };
  const truncated = truncatedToolOutput(serialized);
  return { value: truncated, text: JSON.stringify(truncated) };
}

export function citationLinks(
  citations: readonly SourceLocator[],
): ResourceLink[] {
  const seen = new Set<string>();
  const links: ResourceLink[] = [];
  for (const citation of citations) {
    const ref = citationResource(citation);
    if (!ref) continue;
    const uri = resourceUriFor(ref);
    if (seen.has(uri)) continue;
    seen.add(uri);
    links.push({
      type: "resource_link",
      uri,
      name: `${ref.kind}:${uri.split("/").at(-1)}`,
      mimeType: RESOURCE_MIME[ref.kind],
    });
  }
  return links;
}

function projectIdOf(args: unknown): string | null {
  return isRecord(args) && typeof args.projectId === "string"
    ? args.projectId
    : null;
}

export type ValidatedToolMetadata = {
  valid: boolean;
  projectId: string | null;
  argumentNames: string[];
};

/** Derives diagnostic metadata only from values accepted by the current contract. */
export async function validatedToolMetadata(
  contract: AnyToolContract,
  args: unknown,
): Promise<ValidatedToolMetadata> {
  try {
    const parsed = await contract.inputSchema.safeParseAsync(args);
    if (!parsed.success) {
      return { valid: false, projectId: null, argumentNames: [] };
    }
    return {
      valid: true,
      projectId: projectIdOf(parsed.data),
      argumentNames: isRecord(parsed.data) ? Object.keys(parsed.data) : [],
    };
  } catch {
    return { valid: false, projectId: null, argumentNames: [] };
  }
}

export function emitMcpToolDiagnostic(input: {
  contract: AnyToolContract | undefined;
  toolName?: string;
  toolKind?: "external" | "meta";
  outcome: ToolAuditEvent["outcome"];
  errorCode: string | null;
  durationMs: number;
  metadata?: ValidatedToolMetadata;
  via?: "call_tool";
}): void {
  const {
    contract,
    toolName,
    toolKind,
    outcome,
    errorCode,
    durationMs,
    metadata,
    via,
  } = input;
  const details: Record<string, unknown> = errorCode ? { code: errorCode } : {};
  if (contract) {
    details.tool = contract.name;
    details.kind = contract.kind;
  } else if (toolName) {
    details.tool = toolName;
    details.kind = toolKind ?? "external";
  }
  if (via) details.via = via;
  emitDiagnostic({
    event: "mcp.tool.called",
    ...(outcome === "ok" ? {} : { severity: "warn" as const }),
    message: contract
      ? `${contract.name} ${errorCode ?? outcome}`
      : `${toolName ?? "unknown MCP tool"} ${errorCode ?? outcome}`,
    projectId: metadata?.projectId ?? undefined,
    durationMs,
    outcome,
    details,
  });
  if (contract?.capability === "system:admin") {
    emitDiagnostic({
      event: "admin.tool.called",
      ...(outcome === "ok" ? {} : { severity: "warn" as const }),
      message: contract.name,
      durationMs,
      outcome,
      details: {
        tool: contract.name,
        argumentNames: metadata?.argumentNames ?? [],
      },
    });
  }
}

export async function executeContract(
  contract: AnyToolContract,
  args: unknown,
  requestSignal: AbortSignal,
  deps: ToolDeps,
  options: { via?: "call_tool" } = {},
): Promise<CallToolResult> {
  const started = Date.now();
  const metadata = await validatedToolMetadata(contract, args);
  const signal = AbortSignal.any([
    requestSignal,
    AbortSignal.timeout(deps.toolTimeoutMs),
  ]);
  const audit = (
    patch: Pick<ToolAuditEvent, "outcome" | "errorCode" | "commitSha">,
  ) =>
    deps.onAudit({
      name: contract.name,
      projectId: metadata.projectId,
      durationMs: Date.now() - started,
      ...patch,
    });
  try {
    const base = await runUntilAborted(signal, deps.context);
    signal.throwIfAborted();
    // Once a content write may start, await its real outcome instead of false cancellation.
    const outcome =
      contract.kind === "write"
        ? await contract.execute(args, { ...base, signal })
        : await runUntilAborted(signal, () =>
            contract.execute(args, { ...base, signal }),
          );
    const { value, text } = jsonSafeOutput(outcome.output);
    const content: ContentBlock[] = [
      { type: "text", text },
      ...citationLinks(outcome.citations ?? []),
    ];
    const commitSha =
      contract.kind === "write" &&
      isRecord(value) &&
      typeof value.commitSha === "string"
        ? value.commitSha
        : null;
    const ownsAudit = await audit({
      outcome: "ok",
      errorCode: null,
      commitSha,
    });
    if (ownsAudit) {
      emitMcpToolDiagnostic({
        contract,
        outcome: "ok",
        errorCode: null,
        durationMs: Date.now() - started,
        metadata,
        via: options.via,
      });
    }
    return { content, structuredContent: value };
  } catch (error) {
    const toolError = toolErrorFromUnknown(error);
    const outcome =
      toolError.code === "FORBIDDEN" || toolError.code === "SCOPE_VIOLATION"
        ? "denied"
        : "error";
    const ownsAudit = await audit({
      outcome,
      errorCode: toolError.code,
      commitSha: null,
    });
    if (ownsAudit) {
      emitMcpToolDiagnostic({
        contract,
        outcome,
        errorCode: toolError.code,
        durationMs: Date.now() - started,
        metadata,
        via: options.via,
      });
    }
    return {
      isError: true,
      content: [
        { type: "text", text: `${toolError.code}: ${toolError.message}` },
      ],
      structuredContent: {
        error: {
          code: toolError.code,
          message: toolError.message,
          ...(toolError.reason ? { reason: toolError.reason } : {}),
        },
      },
    };
  }
}

async function runUntilAborted<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("aborted", "AbortError"),
      );
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

const contractJsonSchemas = new WeakMap<
  AnyToolContract,
  Record<string, unknown>
>();
export function contractJsonSchema(
  contract: AnyToolContract,
): Record<string, unknown> {
  let json = contractJsonSchemas.get(contract);
  if (!json) {
    json = z.toJSONSchema(contract.inputSchema, { io: "input" });
    contractJsonSchemas.set(contract, json);
  }
  return json;
}

export function contractAnnotations(
  contract: AnyToolContract,
): ToolAnnotations {
  return {
    readOnlyHint: contract.kind === "read",
    destructiveHint: contract.kind === "write",
    idempotentHint: contract.kind === "write",
    openWorldHint: false,
    ...contract.annotations,
  };
}

const contractSchemas = new WeakMap<AnyToolContract, StandardSchemaWithJSON>();
function schemaForContract(contract: AnyToolContract): StandardSchemaWithJSON {
  let schema = contractSchemas.get(contract);
  if (!schema) {
    const json = contractJsonSchema(contract);
    schema = {
      "~standard": {
        version: 1,
        vendor: "weaver",
        validate: async (value) => {
          const parsed = await contract.inputSchema.safeParseAsync(value);
          return parsed.success
            ? { value: parsed.data }
            : {
                issues: parsed.error.issues.map((issue) => ({
                  message: issue.message,
                })),
              };
        },
        jsonSchema: { input: () => json, output: () => json },
      },
    };
    contractSchemas.set(contract, schema);
  }
  return schema;
}

export function registerContractTools(
  server: McpServer,
  contracts: readonly AnyToolContract[],
  deps: ToolDeps,
): void {
  for (const contract of contracts) {
    server.registerTool(
      contract.name,
      {
        description: contract.description,
        inputSchema: schemaForContract(contract),
        annotations: contractAnnotations(contract),
      },
      (args: unknown, ctx: ServerContext) =>
        executeContract(
          contract,
          args,
          contract.kind === "write" && deps.writeRequestSignal
            ? deps.writeRequestSignal
            : ctx.mcpReq.signal,
          deps,
        ),
    );
  }
}
