import {
  decodeArtifactCursor,
  encodeArtifactCursor,
} from "@weaver/core/services/artifactCursors";
import type { ArtifactEnvelope } from "@weaver/core/services/artifactReads";
import { invalidCursorError } from "@weaver/core/services/contentCursors";
import { z } from "zod";
import {
  defineTool,
  MAX_TOOL_OUTPUT_CHARS,
  ToolError,
  type ToolContext,
} from "../contract";
import {
  artifactTarget,
  artifactEnvelope,
  completeOutputBytes,
  cursorBinding,
  describeFor,
  fileCursorInput,
  readOperation,
  readerResult,
  wrongFormat,
  type ArtifactInput,
} from "./artifactsShared";

const nodeSchema = z.object({
  pointer: z.string(),
  queryPath: z.string(),
  type: z.enum(["array", "object", "string", "number", "boolean", "null"]),
  childCount: z.number().nullable(),
  sampled: z.boolean(),
  sampledCount: z.number(),
  samples: z
    .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
  samplesTruncated: z.boolean().optional(),
});
const overviewSchema = z.object({
  pointer: z.string(),
  total: z.number(),
  offset: z.number(),
  nodes: z.array(nodeSchema),
  nextOffset: z.number().nullable(),
});
const structuredOptions = {
  pointer: z.string().max(8192).default(""),
  depth: z.number().int().min(0).max(5).default(2),
  includeSamples: z.boolean().default(false),
};
type StructureInput = ArtifactInput & {
  pointer: string;
  depth: number;
  includeSamples: boolean;
  limit: number;
  cursor?: string;
};

export async function structuredFor(
  input: StructureInput,
  ctx: ToolContext,
  artifact: ArtifactEnvelope,
  format: "json" | "yaml",
  tool = "inspect_structured_artifact",
) {
  const binding = cursorBinding(tool, artifact, {
    pointer: input.pointer,
    depth: input.depth,
    includeSamples: input.includeSamples,
  });
  const offset = input.cursor
    ? Number(decodeArtifactCursor(input.cursor, binding))
    : 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw invalidCursorError();
  const result = readerResult(
    overviewSchema,
    (
      await readOperation(
        ctx,
        input,
        format === "json" ? "json.structure" : "yaml.structure",
        { ...input, offset },
        artifact.sha256,
      )
    ).value,
  );
  const file = artifactEnvelope(artifact);
  const page = (nodes: z.infer<typeof nodeSchema>[], next: number | null) => ({
    artifact: file,
    result: {
      ...result,
      readable: true,
      format,
      nodes,
      nextOffset: next,
      nextCursor:
        next === null ? null : encodeArtifactCursor(binding, String(next)),
    },
  });
  const nodes: z.infer<typeof nodeSchema>[] = [];
  for (const node of result.nodes) {
    if (
      completeOutputBytes(page([...nodes, node], offset + nodes.length + 1)) >
      MAX_TOOL_OUTPUT_CHARS
    )
      break;
    nodes.push(node);
  }
  if (result.nodes.length && !nodes.length)
    throw new ToolError(
      "BAD_REQUEST",
      "The exact structure address cannot fit this output; inspect a shorter ancestor pointer and select a shallower depth.",
    );
  const output = page(
    nodes,
    nodes.length < result.nodes.length
      ? offset + nodes.length
      : result.nextOffset,
  );
  if (completeOutputBytes(output) > MAX_TOOL_OUTPUT_CHARS)
    throw new ToolError(
      "BAD_REQUEST",
      "The exact structure address cannot fit this output; inspect a shorter ancestor pointer.",
    );
  return output;
}

export const inspectStructuredArtifactTool = defineTool({
  name: "inspect_structured_artifact",
  kind: "read",
  capability: "content:read",
  description:
    "Inspects JSON/YAML shape at an exact JSON Pointer before selective query_json_artifact reads. Returns types, child counts and usable query paths; arrays sample first 20 elements. Values omitted unless includeSamples. Cursor pages wide structures; raw YAML uses read_text_artifact.",
  inputSchema: z.object({
    ...artifactTarget,
    ...structuredOptions,
    limit: z.number().int().min(1).max(200).default(50),
    cursor: fileCursorInput,
  }),
  async execute(input, ctx) {
    const { artifact, format } = await describeFor(input, ctx);
    if (format !== "json" && format !== "yaml")
      throw wrongFormat(format, "inspect_structured_artifact");
    return { output: await structuredFor(input, ctx, artifact, format) };
  },
});
