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
  csvQuery,
  rejectCsvOptions,
  type CsvOptions,
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

export const textPositionSchema = z.object({
  line: z.number().int().positive(),
  charOffset: z.number().int().nonnegative(),
});
import {
  csvPositionString,
  csvSearchSchema,
  parseCsvPosition,
} from "./artifactsCsv";

const textReadSchema = z.object({
  text: z.string(),
  start: textPositionSchema,
  end: textPositionSchema,
  lineCount: z.number(),
  nextPosition: textPositionSchema.nullable(),
});
const headingSchema = z.object({
  id: z.string(),
  title: z.string(),
  level: z.number(),
  startLine: z.number(),
  endLine: z.number(),
});
const overviewSchema = z.object({
  lineCount: z.number(),
  headingCount: z.number(),
  headings: z.array(headingSchema),
  nextOffset: z.number().nullable(),
});
export const textSearchSchema = z.object({
  matches: z.array(textPositionSchema.extend({ snippet: z.string() })),
  nextPosition: textPositionSchema.nullable(),
});

export function textFamily(
  format: string | null,
): format is "text" | "markdown" | "yaml" | "csv" {
  return (
    format === "text" ||
    format === "markdown" ||
    format === "yaml" ||
    format === "csv"
  );
}

export function parseTextPosition(position: string) {
  if (!/^\d{1,12}:\d{1,12}$/.test(position)) throw invalidCursorError();
  const [line, charOffset] = position.split(":").map(Number) as [
    number,
    number,
  ];
  if (line < 1) throw invalidCursorError();
  return { line, charOffset };
}

export function textPositionString(position: {
  line: number;
  charOffset: number;
}): string {
  return `${position.line}:${position.charOffset}`;
}

export const readTextArtifactTool = defineTool({
  name: "read_text_artifact",
  kind: "read",
  capability: "content:read",
  description:
    "Reads original TXT/Markdown/YAML/CSV source lines, or a Markdown sectionId from overview. Use cursor for exact long-line continuation; omit startLine or repeat the original range start. Raw source recovers oversized CSV cells and unsupported YAML.",
  inputSchema: z.object({
    ...artifactTarget,
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(500).default(100),
    sectionId: z.string().max(100).optional(),
    cursor: fileCursorInput,
  }),
  async execute(input, ctx) {
    const { artifact, format } = await describeFor(input, ctx);
    if (!textFamily(format)) throw wrongFormat(format, "read_text_artifact");
    if (
      input.sectionId !== undefined &&
      (input.startLine !== undefined || input.endLine !== undefined)
    )
      throw new ToolError(
        "BAD_REQUEST",
        "sectionId cannot be combined with startLine or endLine",
      );
    let originalStart = input.startLine ?? 1;
    if (input.cursor) {
      try {
        const untrusted = JSON.parse(
          Buffer.from(input.cursor.split(".")[0]!, "base64url").toString(
            "utf8",
          ),
        ) as { position?: unknown };
        if (
          typeof untrusted.position !== "string" ||
          !/^\d{1,12}:\d{1,12}:\d{1,12}$/.test(untrusted.position)
        )
          throw invalidCursorError();
        originalStart = Number(untrusted.position.split(":")[0]);
      } catch {
        throw invalidCursorError();
      }
      if (
        originalStart < 1 ||
        (input.startLine !== undefined && originalStart !== input.startLine)
      )
        throw invalidCursorError();
    }
    const binding = cursorBinding("read_text_artifact", artifact, {
      startLine: originalStart,
      endLine: input.endLine ?? null,
      sectionId: input.sectionId ?? null,
    });
    const position = input.cursor
      ? parseTextPosition(
          decodeArtifactCursor(input.cursor, binding)
            .split(":")
            .slice(1)
            .join(":"),
        )
      : undefined;
    const file = artifactEnvelope(artifact);
    const placeholder = { line: 999999999999, charOffset: 999999999999 };
    const head = {
      format,
      text: "",
      start: placeholder,
      end: placeholder,
      lineCount: 500,
      nextPosition: placeholder,
      nextCursor: encodeArtifactCursor(
        binding,
        "999999999999:999999999999:999999999999",
      ),
    };
    const budget =
      MAX_TOOL_OUTPUT_CHARS -
      completeOutputBytes({ artifact: file, result: head });
    const result = readerResult(
      textReadSchema,
      (
        await readOperation(
          ctx,
          input,
          "text.read",
          {
            startLine:
              input.sectionId === undefined ? originalStart : undefined,
            endLine: input.endLine,
            sectionId: input.sectionId,
            limit: input.limit,
            position,
            serializedTextBytes: budget,
          },
          artifact.sha256,
        )
      ).value,
    );
    return {
      output: {
        artifact: file,
        result: {
          ...result,
          format,
          nextCursor:
            result.nextPosition === null
              ? null
              : encodeArtifactCursor(
                  binding,
                  `${originalStart}:${textPositionString(result.nextPosition)}`,
                ),
        },
      },
    };
  },
});

export async function textOverviewFor(
  input: ArtifactInput & { cursor?: string },
  ctx: ToolContext,
  artifact: ArtifactEnvelope,
  format: "text" | "markdown",
) {
  const binding = cursorBinding("get_artifact_overview", artifact, {});
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
        "text.overview",
        { offset },
        artifact.sha256,
      )
    ).value,
  );
  const file = artifactEnvelope(artifact);
  const page = (
    headings: z.infer<typeof headingSchema>[],
    next: number | null,
  ) => ({
    artifact: file,
    result: {
      ...result,
      readable: true,
      format,
      headings,
      nextOffset: next,
      nextCursor:
        next === null ? null : encodeArtifactCursor(binding, String(next)),
    },
  });
  const headings: z.infer<typeof headingSchema>[] = [];
  for (const heading of result.headings) {
    if (
      completeOutputBytes(
        page([...headings, heading], offset + headings.length + 1),
      ) > MAX_TOOL_OUTPUT_CHARS
    )
      break;
    headings.push(heading);
  }
  if (result.headings.length && !headings.length)
    throw new ToolError(
      "BAD_REQUEST",
      "overview entry cannot fit; use read_text_artifact",
    );
  return page(
    headings,
    headings.length < result.headings.length
      ? offset + headings.length
      : result.nextOffset,
  );
}

export async function textSearchFor(
  input: ArtifactInput &
    CsvOptions & {
      query: string;
      limit?: number;
      cursor?: string;
      matchCase: boolean;
    },
  ctx: ToolContext,
  artifact: ArtifactEnvelope,
  format: "text" | "markdown" | "csv" | "yaml",
) {
  if (input.matchCase)
    throw new ToolError(
      "BAD_REQUEST",
      "Text and CSV search is case-insensitive; omit matchCase or set it to false",
    );
  if (format !== "csv") rejectCsvOptions(input);
  const binding = cursorBinding("search_artifact_text", artifact, {
    query: input.query,
    ...(format === "csv" ? csvQuery(input) : {}),
  });
  const encoded = input.cursor
    ? decodeArtifactCursor(input.cursor, binding)
    : undefined;
  const position =
    encoded === undefined
      ? undefined
      : format === "csv"
        ? parseCsvPosition(encoded)
        : parseTextPosition(encoded);
  const raw = (
    await readOperation(
      ctx,
      input,
      format === "csv" ? "csv.search" : "text.search",
      { ...input, limit: input.limit ?? 25, position },
      artifact.sha256,
    )
  ).value;
  const result =
    format === "csv"
      ? readerResult(csvSearchSchema, raw)
      : readerResult(textSearchSchema, raw);
  const file = artifactEnvelope(artifact);
  type Match = (typeof result.matches)[number];
  const positionOf = (value: NonNullable<typeof result.nextPosition>) =>
    "row" in value ? csvPositionString(value) : textPositionString(value);
  const page = (matches: Match[], next: typeof result.nextPosition) => ({
    artifact: file,
    result: {
      format,
      query: input.query,
      matches,
      truncated: next !== null,
      nextPosition:
        next === null
          ? null
          : "row" in next
            ? {
                row: next.row,
                column: next.column,
                charOffset: next.charOffset,
              }
            : { line: next.line, charOffset: next.charOffset },
      nextCursor:
        next === null ? null : encodeArtifactCursor(binding, positionOf(next)),
    },
  });
  const matches: Match[] = [];
  for (const [index, match] of result.matches.entries()) {
    const next = result.matches[index + 1] ?? result.nextPosition;
    if (
      completeOutputBytes(page([...matches, match], next)) >
      MAX_TOOL_OUTPUT_CHARS
    )
      break;
    matches.push(match);
  }
  if (result.matches.length && !matches.length)
    throw new ToolError(
      "BAD_REQUEST",
      "Search match cannot fit; narrow the query or use read_text_artifact",
    );
  return page(
    matches,
    matches.length < result.matches.length
      ? result.matches[matches.length]!
      : result.nextPosition,
  );
}
