import {
  createLlmConnection,
  createLlmModel,
  deleteLlmConnection,
  deleteLlmModel,
  importLlmModels,
  testLlmConnection,
  testLlmModel,
  updateLlmConnection,
  updateLlmModel,
  type LlmAdminDeps,
} from "@weaver/core/services/llmConnections";
import { setLlmRoute } from "@weaver/core/services/llmRoutes";
import {
  connectionIdInput,
  createLlmConnectionInput,
  createLlmModelInput,
  importLlmModelsInput,
  modelIdInput,
  setEmbeddingCompatibilityInput,
  setLlmRouteInput,
  updateLlmConnectionInput,
  updateLlmModelInput,
} from "@weaver/core/services/llmSchemas";
import {
  clearEmbeddingCompatibility,
  verifyEmbeddingCompatibility,
} from "@weaver/core/services/llmVectorSpace";
import {
  MAX_TOOL_OUTPUT_CHARS,
  ToolError,
  defineTool,
  type ToolContext,
  utf8Bytes,
} from "../../contract";

export function llmDeps(ctx: ToolContext): LlmAdminDeps {
  if (!ctx.llm) {
    throw new ToolError(
      "INTERNAL",
      "LLM administration unavailable on this transport",
    );
  }
  return { ring: ctx.llm.ring, fetchImpl: ctx.llm.fetchImpl };
}

export function boundedConnectionOutput<
  T extends { models: readonly unknown[] },
>(
  connection: T,
): {
  connection: Omit<T, "models"> & {
    models: unknown[];
    modelsTruncated: boolean;
  };
} {
  const bounded = {
    ...connection,
    models: [...connection.models],
    modelsTruncated: false,
  };
  while (
    utf8Bytes(JSON.stringify({ connection: bounded })) >
      MAX_TOOL_OUTPUT_CHARS &&
    bounded.models.length > 0
  ) {
    bounded.models.pop();
    bounded.modelsTruncated = true;
  }
  return { connection: bounded };
}

type ConnectionTestResult = Awaited<ReturnType<typeof testLlmConnection>>;
type ImportResult = Awaited<ReturnType<typeof importLlmModels>>;

function boundedArrayOutput<T extends object, K extends keyof T>(
  base: T,
  key: K,
): T & { truncated: boolean } {
  const items = base[key];
  if (!Array.isArray(items)) return { ...base, truncated: false };
  const kept: unknown[] = [];
  let output = { ...base, [key]: kept, truncated: items.length > 0 };
  for (const item of items) {
    const candidate = {
      ...base,
      [key]: [...kept, item],
      truncated: kept.length + 1 < items.length,
    };
    if (utf8Bytes(JSON.stringify(candidate)) > MAX_TOOL_OUTPUT_CHARS) break;
    kept.push(item);
    output = candidate;
  }
  return output;
}

export function boundedConnectionTestOutput(result: ConnectionTestResult) {
  return boundedArrayOutput(
    {
      outcome: result.outcome,
      durationMs: result.durationMs,
      summary: result.summary,
      models: result.models ?? [],
    },
    "models",
  );
}

export function boundedImportOutput(result: ImportResult) {
  return boundedArrayOutput(result, "skipped");
}

export const createLlmConnectionTool = defineTool({
  name: "create_llm_connection",
  description:
    "Declare a provider connection. The credential is encrypted at rest and never returned. Run test_llm_connection afterwards to discover models.",
  kind: "write",
  capability: "system:admin",
  inputSchema: createLlmConnectionInput,
  async execute(input, ctx) {
    return {
      output: boundedConnectionOutput(
        await createLlmConnection(ctx.db, ctx.actor, llmDeps(ctx), input),
      ),
    };
  },
});

export const updateLlmConnectionTool = defineTool({
  name: "update_llm_connection",
  description:
    "Change a connection's name, endpoint, timeout, enabled flag, or rotate its credential (blank keeps the current one).",
  kind: "write",
  capability: "system:admin",
  inputSchema: updateLlmConnectionInput,
  async execute(input, ctx) {
    return {
      output: boundedConnectionOutput(
        await updateLlmConnection(ctx.db, ctx.actor, llmDeps(ctx), input),
      ),
    };
  },
});

export const deleteLlmConnectionTool = defineTool({
  name: "delete_llm_connection",
  description:
    "Delete a connection and its models. Refused while one of its models is routed.",
  kind: "write",
  capability: "system:admin",
  inputSchema: connectionIdInput,
  async execute(input, ctx) {
    await deleteLlmConnection(ctx.db, ctx.actor, input.connectionId);
    return { output: { deleted: true } };
  },
});

export const createLlmModelTool = defineTool({
  name: "create_llm_model",
  description:
    "Declare a model on a connection with its capabilities, limits, dimensions, optional OpenRouter upstream provider, and prices.",
  kind: "write",
  capability: "system:admin",
  inputSchema: createLlmModelInput,
  async execute(input, ctx) {
    return {
      output: { model: await createLlmModel(ctx.db, ctx.actor, input) },
    };
  },
});

export const updateLlmModelTool = defineTool({
  name: "update_llm_model",
  description:
    "Change a declared model's name, capabilities, limits, dimensions, dimension mode, optional OpenRouter upstream provider, or prices.",
  kind: "write",
  capability: "system:admin",
  inputSchema: updateLlmModelInput,
  async execute(input, ctx) {
    return {
      output: {
        model: await updateLlmModel(
          ctx.db,
          ctx.actor,
          input,
          ctx.llm ? llmDeps(ctx) : undefined,
        ),
      },
    };
  },
});

export const deleteLlmModelTool = defineTool({
  name: "delete_llm_model",
  description: "Delete a declared model. Refused while it is routed.",
  kind: "write",
  capability: "system:admin",
  inputSchema: modelIdInput,
  async execute(input, ctx) {
    await deleteLlmModel(ctx.db, ctx.actor, input.modelId);
    return { output: { deleted: true } };
  },
});

export const setLlmRouteTool = defineTool({
  name: "set_llm_route",
  description:
    "Assign a declared model to an AI purpose with per-route thinking effort (provider_default, none, low, medium, high), or clear it with null. Same capability and dimension checks as the UI.",
  kind: "write",
  capability: "system:admin",
  inputSchema: setLlmRouteInput,
  async execute(input, ctx) {
    return {
      output: {
        route: await setLlmRoute(
          ctx.db,
          ctx.actor,
          input,
          ctx.llm ? llmDeps(ctx) : undefined,
        ),
      },
    };
  },
});

export const setEmbeddingCompatibilityTool = defineTool({
  name: "set_embedding_compatibility",
  description:
    "Verify an embedding model as vector-compatible with a reference model by comparing 8 fixed sample texts (minimum cosine 0.98); compatible models share existing knowledge vectors. Pass referenceModelId null to remove the compatibility.",
  kind: "write",
  capability: "system:admin",
  inputSchema: setEmbeddingCompatibilityInput,
  async execute(input, ctx) {
    return {
      output:
        input.referenceModelId === null
          ? await clearEmbeddingCompatibility(ctx.db, ctx.actor, {
              modelId: input.modelId,
            })
          : await verifyEmbeddingCompatibility(
              ctx.db,
              ctx.actor,
              llmDeps(ctx),
              {
                modelId: input.modelId,
                referenceModelId: input.referenceModelId,
              },
            ),
    };
  },
});

export const testLlmConnectionTool = defineTool({
  name: "test_llm_connection",
  description:
    "Call the provider's model list, record the outcome on the connection, and return the discovered models with limits and capabilities (capped at 500).",
  kind: "write",
  capability: "system:admin",
  inputSchema: connectionIdInput,
  async execute(input, ctx) {
    return {
      output: boundedConnectionTestOutput(
        await testLlmConnection(
          ctx.db,
          ctx.actor,
          llmDeps(ctx),
          input.connectionId,
        ),
      ),
    };
  },
});

export const testLlmModelTool = defineTool({
  name: "test_llm_model",
  description:
    "Ping a chat model with a one-token completion or probe an embedding model, recording and returning usage.",
  kind: "write",
  capability: "system:admin",
  inputSchema: modelIdInput,
  async execute(input, ctx) {
    return {
      output: await testLlmModel(
        ctx.db,
        ctx.actor,
        llmDeps(ctx),
        input.modelId,
      ),
    };
  },
});

export const importLlmModelsTool = defineTool({
  name: "import_llm_models",
  description:
    "Declare discovered models in bulk, probing embedding dimensions where the endpoint did not report them; updateExisting refreshes limits only.",
  kind: "write",
  capability: "system:admin",
  inputSchema: importLlmModelsInput,
  async execute(input, ctx) {
    return {
      output: boundedImportOutput(
        await importLlmModels(ctx.db, ctx.actor, llmDeps(ctx), input),
      ),
    };
  },
});

export const LLM_WRITE_ADMIN_TOOLS = [
  createLlmConnectionTool,
  updateLlmConnectionTool,
  deleteLlmConnectionTool,
  createLlmModelTool,
  updateLlmModelTool,
  deleteLlmModelTool,
  setLlmRouteTool,
  setEmbeddingCompatibilityTool,
  testLlmConnectionTool,
  testLlmModelTool,
  importLlmModelsTool,
] as const;
