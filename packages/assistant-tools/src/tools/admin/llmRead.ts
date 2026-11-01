import { z } from "zod";
import {
  listLlmConnectionsPage,
  listLlmModelsPage,
  type PagedLlmConnectionSummary,
  type PagedLlmModelSummary,
} from "@weaver/core/services/llmConnections";
import {
  listLlmRoutesPage,
  type LlmRouteView,
} from "@weaver/core/services/llmRoutes";
import { encodePageCursor } from "@weaver/core/services/adminPaging";
import { MAX_TOOL_OUTPUT_CHARS, defineTool, utf8Bytes } from "../../contract";
import { listInput, pagedOutput } from "./paging";

export const listLlmConnectionsTool = defineTool({
  name: "list_llm_connections",
  description:
    "Declared LLM connections with bounded model summaries, limits, last test outcome, and key version; never credential material.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object(listInput),
  async execute(input, ctx) {
    const page = await listLlmConnectionsPage(ctx.db, ctx.actor, input);
    const items = page.items.map((connection) => {
      const item = { ...connection, models: [...connection.models] };
      while (
        utf8Bytes(JSON.stringify(item)) > MAX_TOOL_OUTPUT_CHARS / 2 &&
        item.models.length
      ) {
        item.models.pop();
        item.modelsTruncated = true;
      }
      return item;
    });
    return {
      output: pagedOutput(
        {
          ...page,
          items,
          truncated:
            page.truncated || items.some((item) => item.modelsTruncated),
        },
        (item: PagedLlmConnectionSummary) => encodePageCursor([item.id]),
      ),
    };
  },
});

export const listLlmModelsTool = defineTool({
  name: "list_llm_models",
  description:
    "Declared models across connections or for one connection, with capabilities, limits, dimensions, and prices.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({ connectionId: z.uuid().optional(), ...listInput }),
  async execute(input, ctx) {
    return {
      output: pagedOutput(
        await listLlmModelsPage(ctx.db, ctx.actor, input),
        (item: PagedLlmModelSummary) => encodePageCursor([item.id]),
      ),
    };
  },
});

export const listLlmRoutesTool = defineTool({
  name: "list_llm_routes",
  description:
    "The active purposes with their assigned model and health; page with cursor.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object(listInput),
  async execute(input, ctx) {
    return {
      output: pagedOutput(
        await listLlmRoutesPage(ctx.db, ctx.actor, input),
        (item: LlmRouteView) => encodePageCursor([item.purpose]),
      ),
    };
  },
});

export const LLM_READ_ADMIN_TOOLS = [
  listLlmConnectionsTool,
  listLlmModelsTool,
  listLlmRoutesTool,
] as const;
