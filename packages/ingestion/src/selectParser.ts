import type { IngestionSettings } from "@weaver/core/ingestion/settings";
import { createDoclingParser, DoclingUnreachableError } from "./docling";
import type { DocumentParser, ParseInput, ParseOutcome } from "./parser";

const FALLBACK_WARNING =
  "docling-serve was unreachable; the file was parsed natively";

/** Docling is preferred for the types it supports whenever an endpoint is configured (spec §6). */
export function parsersFor(
  settings: IngestionSettings,
  native: DocumentParser,
  fetchImpl?: typeof fetch,
): DocumentParser[] {
  return settings.doclingBaseUrl
    ? [
        createDoclingParser({
          baseUrl: settings.doclingBaseUrl,
          timeoutMs: settings.doclingTimeoutMs,
          fetchImpl,
        }),
        native,
      ]
    : [native];
}

export async function parseWithFallback(
  parsers: DocumentParser[],
  input: ParseInput,
  signal: AbortSignal,
  onSelected: (parser: DocumentParser) => Promise<void>,
): Promise<{ parser: DocumentParser; outcome: ParseOutcome } | null> {
  const candidates = parsers.filter((parser) =>
    parser.supports(input.mimeType),
  );
  let fallback = false;
  for (const parser of candidates) {
    await onSelected(parser);
    try {
      const outcome = await parser.parse(input, signal);
      if (fallback && !("failureKind" in outcome))
        outcome.warnings.unshift(FALLBACK_WARNING);
      return { parser, outcome };
    } catch (error) {
      if (
        !(error instanceof DoclingUnreachableError) ||
        parser === candidates.at(-1)
      )
        throw error;
      fallback = true;
    }
  }
  return null;
}
