import { z } from "zod";
import { encodePageCursor } from "@weaver/core/services/adminPaging";
import {
  getIngestionFileDetail,
  listIngestionBatches,
  listIngestionFiles,
  type IngestionBatchRow,
  type IngestionFileDetailRow,
} from "@weaver/core/services/ingestionInspection";
import {
  MAX_TOOL_OUTPUT_CHARS,
  ToolError,
  clampText,
  defineTool,
  requireScope,
  type ToolOutcome,
  utf8Bytes,
} from "../../contract";
import { listInput, pagedOutput } from "./paging";

const fileStatuses = [
  "pending",
  "parsing",
  "extracting",
  "linking",
  "ready",
  "accepting",
  "accepted",
  "rejected",
  "failed",
  "blocked_configuration",
] as const;

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function batchOutput(item: IngestionBatchRow) {
  return { ...item, createdAt: item.createdAt.toISOString() };
}

type FileTimestamps = {
  parseStartedAt: Date | null;
  parseEndedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function fileOutput<T extends FileTimestamps>(item: T) {
  return {
    ...item,
    parseStartedAt: iso(item.parseStartedAt),
    parseEndedAt: iso(item.parseEndedAt),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

type DraftDetail = NonNullable<IngestionFileDetailRow["draft"]>;
type IngestionFileDetailOutput = ReturnType<
  typeof fileOutput<Omit<IngestionFileDetailRow, "draft">>
> & {
  draft:
    | (Omit<DraftDetail, "editedAt" | "markdown"> & {
        editedAt: string | null;
        markdown: string | null;
      })
    | null;
  markdownTruncated: boolean;
  warningsTruncated: boolean;
};

export const listIngestionBatchesTool = defineTool({
  name: "list_ingestion_batches",
  description:
    "Import batches for one project with derived status and per-status file counts.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({ projectId: z.uuid(), ...listInput }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    const page = await listIngestionBatches(ctx.db, ctx.actor, input);
    return {
      output: pagedOutput(
        { ...page, items: page.items.map(batchOutput) },
        (item) => encodePageCursor([item.createdAt, item.id]),
      ),
    };
  },
});

export const listIngestionFilesTool = defineTool({
  name: "list_ingestion_files",
  description:
    "Import files for one project with parse and failure metadata; optionally filtered by batch or status. Items never contain draft content; use get_ingestion_file for that.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({
    projectId: z.uuid(),
    batchId: z.uuid().optional(),
    status: z.enum(fileStatuses).optional(),
    ...listInput,
  }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    const page = await listIngestionFiles(ctx.db, ctx.actor, input);
    return {
      output: pagedOutput(
        { ...page, items: page.items.map(fileOutput) },
        (item) => encodePageCursor([item.createdAt, item.id]),
      ),
    };
  },
});

export const getIngestionFileTool = defineTool({
  name: "get_ingestion_file",
  description:
    "One import file with parse and failure metadata plus its review draft; draft markdown is clamped and warnings trimmed to the tool output budget, flagged with markdownTruncated and warningsTruncated.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({ projectId: z.uuid(), fileId: z.uuid() }),
  async execute(input, ctx): Promise<ToolOutcome<IngestionFileDetailOutput>> {
    requireScope(ctx, input.projectId);
    const file = await getIngestionFileDetail(ctx.db, ctx.actor, input);
    const { draft, ...rest } = file;
    const head = fileOutput(rest);
    if (!draft) {
      return {
        output: {
          ...head,
          draft: null,
          markdownTruncated: false,
          warningsTruncated: false,
        },
      };
    }
    const meta = { ...draft, editedAt: iso(draft.editedAt) };
    const full = draft.markdown;
    const warnings = [...draft.warnings];
    const warningTotal = warnings.length;
    let budget = MAX_TOOL_OUTPUT_CHARS;
    let clamped = full === null ? null : clampText(full, budget);
    const build = () => ({
      ...head,
      draft: { ...meta, markdown: clamped?.text ?? null, warnings },
      markdownTruncated: clamped?.truncated ?? false,
      warningsTruncated: warnings.length < warningTotal,
    });
    let output = build();
    while (
      full !== null &&
      budget > 0 &&
      utf8Bytes(JSON.stringify(output)) > MAX_TOOL_OUTPUT_CHARS
    ) {
      budget = Math.floor(budget / 2);
      clamped = clampText(full, budget);
      output = build();
    }
    while (
      warnings.length > 0 &&
      utf8Bytes(JSON.stringify(output)) > MAX_TOOL_OUTPUT_CHARS
    ) {
      warnings.pop();
      output = build();
    }
    if (utf8Bytes(JSON.stringify(output)) > MAX_TOOL_OUTPUT_CHARS) {
      throw new ToolError(
        "INTERNAL",
        "ingestion file detail exceeds tool output limit",
      );
    }
    return { output };
  },
});

export const INGESTION_READ_ADMIN_TOOLS = [
  listIngestionBatchesTool,
  listIngestionFilesTool,
  getIngestionFileTool,
] as const;
