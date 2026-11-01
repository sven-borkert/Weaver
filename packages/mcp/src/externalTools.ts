import type {
  CallToolResult,
  ContentBlock,
  McpServer,
  ServerContext,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import {
  MAX_TOOL_OUTPUT_CHARS,
  toolErrorFromUnknown,
  truncatedToolOutput,
} from "@weaver/assistant-tools/contract";
import type {
  ExternalResult,
  InboundExternalTool,
  JsonObject,
} from "@weaver/core/externalMcp/types";
import { emitMcpToolDiagnostic, type ToolAuditEvent } from "./tools";

export type ExternalToolDeps = {
  call: (input: {
    tool: InboundExternalTool;
    arguments: JsonObject;
    signal: AbortSignal;
  }) => Promise<ExternalResult>;
  writeRequestSignal?: AbortSignal;
  onAudit: (event: ToolAuditEvent) => Promise<boolean>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Core validates against the reviewed schema; the SDK only needs the JSON form.
function passThroughSchema(json: JsonObject): StandardSchemaWithJSON {
  return {
    "~standard": {
      version: 1,
      vendor: "weaver-external",
      validate: (value) => ({ value }),
      jsonSchema: { input: () => json, output: () => json },
    },
  };
}

function completedContent(output: unknown): {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
} {
  const record = isRecord(output) ? output : {};
  const content = Array.isArray(record.content)
    ? (record.content as ContentBlock[])
    : [];
  const structuredContent = isRecord(record.structuredContent)
    ? record.structuredContent
    : undefined;
  const size = Buffer.byteLength(
    JSON.stringify({ content, structuredContent }),
    "utf8",
  );
  if (size <= MAX_TOOL_OUTPUT_CHARS)
    return { content, ...(structuredContent ? { structuredContent } : {}) };
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(truncatedToolOutput(JSON.stringify(content))),
      },
    ],
  };
}

export async function executeExternal(
  tool: InboundExternalTool,
  args: unknown,
  signal: AbortSignal,
  deps: ExternalToolDeps,
  options: { via?: "call_tool" } = {},
): Promise<CallToolResult> {
  const started = Date.now();
  const finish = async (
    outcome: ToolAuditEvent["outcome"],
    errorCode: string | null,
  ) => {
    const durationMs = Date.now() - started;
    if (
      await deps.onAudit({
        name: tool.name,
        projectId: null,
        outcome,
        errorCode,
        durationMs,
        commitSha: null,
      })
    )
      emitMcpToolDiagnostic({
        contract: undefined,
        toolName: tool.name,
        outcome,
        errorCode,
        durationMs,
        metadata: {
          valid: true,
          projectId: null,
          argumentNames: isRecord(args) ? Object.keys(args) : [],
        },
        via: options.via,
      });
  };
  try {
    const result = await deps.call({
      tool,
      arguments: (isRecord(args) ? args : {}) as JsonObject,
      signal,
    });
    if (result.status === "completed") {
      await finish("ok", null);
      return completedContent(result.output);
    }
    const error = result.error ?? {
      code: "EXTERNAL_OUTCOME_UNKNOWN",
      message: "External call outcome is unknown",
    };
    await finish(result.status === "denied" ? "denied" : "error", error.code);
    return {
      isError: true,
      content: [{ type: "text", text: `${error.code}: ${error.message}` }],
      structuredContent: { error, callId: result.callId },
    };
  } catch (thrown) {
    const toolError = toolErrorFromUnknown(thrown);
    await finish(
      toolError.code === "FORBIDDEN" || toolError.code === "NOT_FOUND"
        ? "denied"
        : "error",
      toolError.code,
    );
    return {
      isError: true,
      content: [
        { type: "text", text: `${toolError.code}: ${toolError.message}` },
      ],
      structuredContent: {
        error: { code: toolError.code, message: toolError.message },
      },
    };
  }
}

export function externalAnnotations(
  tool: InboundExternalTool,
): ToolAnnotations {
  return {
    readOnlyHint: tool.effect === "read",
    destructiveHint: tool.effect === "write",
    idempotentHint: false,
    openWorldHint: true,
  };
}

export function registerExternalTools(
  server: McpServer,
  tools: readonly InboundExternalTool[],
  deps: ExternalToolDeps,
): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.remoteName,
        description: tool.description,
        inputSchema: passThroughSchema(tool.inputSchema),
        annotations: externalAnnotations(tool),
      },
      (args: unknown, ctx: ServerContext) =>
        executeExternal(
          tool,
          args,
          tool.effect === "write" && deps.writeRequestSignal
            ? deps.writeRequestSignal
            : ctx.mcpReq.signal,
          deps,
        ),
    );
  }
}
