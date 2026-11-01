import type { LlmModelSnapshot } from "@weaver/core/services/llmRoutes";

export type ParseInput = {
  fileId: string;
  projectId: string;
  jobId: string | null;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  /** Called once with the resolved OCR route before the first vision call. */
  onRouteResolved?: (snapshot: LlmModelSnapshot) => Promise<void>;
};

export type ParsedTable = {
  name: string | null;
  columns: string[];
  rows: string[][];
};
export type ParsedAsset = {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
};
export type ParsedDocument = {
  markdown: string;
  tables: ParsedTable[];
  assets: ParsedAsset[];
  pageCount?: number;
  ocrPages?: number;
  warnings: string[];
};
export type ParseFailureKind =
  "parser" | "validation" | "provider" | "configuration";
export type ParseFailure = { failureKind: ParseFailureKind; message: string };
export type ParseOutcome = ParsedDocument | ParseFailure;

export interface DocumentParser {
  readonly id: string;
  readonly version: string;
  supports(mimeType: string): boolean;
  parse(input: ParseInput, signal: AbortSignal): Promise<ParseOutcome>;
}

export function isParseFailure(outcome: ParseOutcome): outcome is ParseFailure {
  return "failureKind" in outcome;
}

export function emptyDocument(
  markdown: string,
  warnings: string[] = [],
): ParsedDocument {
  return { markdown, tables: [], assets: [], warnings };
}
