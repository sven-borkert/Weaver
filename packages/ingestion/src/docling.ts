import { createPinnedFetch } from "@weaver/config/outboundFetch";
import {
  ProviderResponseLimitError,
  readBoundedResponse,
} from "@weaver/core/ai/http";
import { z } from "zod";
import { MAX_MARKDOWN_CHARS } from "@weaver/core/documents/limits";
import { normalizeMimeType } from "@weaver/core/ingestion/mimeTypes";
import { doclingEndpoint } from "@weaver/core/ingestion/settings";
import {
  emptyDocument,
  type DocumentParser,
  type ParseOutcome,
} from "./parser";

export const DOCLING_PARSER_ID = "docling";
export const DOCLING_PARSER_VERSION = "1";
const DOCLING_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/tiff",
  "image/webp",
]);
const MAX_RESPONSE_BYTES = MAX_MARKDOWN_CHARS * 4 + 65_536;

export class DoclingUnreachableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DoclingUnreachableError";
  }
}

const responseSchema = z.object({
  status: z.string(),
  document: z.object({ md_content: z.string().nullish() }).nullish(),
  errors: z.array(z.unknown()).optional(),
});

function errorMessages(errors: unknown[]): string[] {
  return errors.slice(0, 5).map((error) => {
    if (typeof error === "string") return `docling-serve: ${error}`;
    if (
      error &&
      typeof error === "object" &&
      "error_message" in error &&
      typeof error.error_message === "string"
    ) {
      return `docling-serve: ${error.error_message}`;
    }
    return "docling-serve reported an error";
  });
}

export function createDoclingParser(options: {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): DocumentParser {
  const fetchImpl = options.fetchImpl ?? createPinnedFetch();
  return {
    id: DOCLING_PARSER_ID,
    version: DOCLING_PARSER_VERSION,
    supports: (mimeType) => DOCLING_TYPES.has(normalizeMimeType(mimeType)),
    async parse(input, signal): Promise<ParseOutcome> {
      const form = new FormData();
      form.append(
        "files",
        new Blob([new Uint8Array(input.bytes)], {
          type: normalizeMimeType(input.mimeType),
        }),
        input.fileName,
      );
      form.append("to_formats", "md");
      form.append("image_export_mode", "placeholder");
      form.append("do_ocr", "true");
      let response: Response;
      try {
        response = await fetchImpl(
          doclingEndpoint(options.baseUrl, "v1/convert/file"),
          {
            method: "POST",
            body: form,
            headers: { accept: "application/json" },
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(options.timeoutMs),
            ]),
          },
        );
      } catch (error) {
        if (signal.aborted) throw error;
        throw new DoclingUnreachableError("docling-serve is unreachable", {
          cause: error,
        });
      }
      if (!response.ok) {
        return {
          failureKind: "parser",
          message: `docling-serve answered ${response.status}`,
        };
      }
      let text: string;
      try {
        text = await readBoundedResponse(response, MAX_RESPONSE_BYTES);
      } catch (error) {
        if (signal.aborted) throw error;
        return error instanceof ProviderResponseLimitError
          ? {
              failureKind: "validation",
              message: `parsed content exceeds ${MAX_MARKDOWN_CHARS} characters`,
            }
          : {
              failureKind: "parser",
              message: "docling-serve returned an unreadable response",
            };
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return {
          failureKind: "parser",
          message: "docling-serve returned an unreadable response",
        };
      }
      const parsed = responseSchema.safeParse(body);
      if (!parsed.success)
        return {
          failureKind: "parser",
          message: "docling-serve returned an unexpected response",
        };
      const warnings = errorMessages(parsed.data.errors ?? []);
      if (
        parsed.data.status !== "success" &&
        parsed.data.status !== "partial_success"
      ) {
        return {
          failureKind: "parser",
          message: `docling-serve reported ${parsed.data.status}`,
        };
      }
      if (parsed.data.status === "partial_success")
        warnings.unshift("docling-serve reported partial success");
      const markdown = (parsed.data.document?.md_content ?? "").trim();
      if (markdown.length === 0)
        return {
          failureKind: "validation",
          message: "docling-serve returned no text",
        };
      if (markdown.length > MAX_MARKDOWN_CHARS) {
        return {
          failureKind: "validation",
          message: `parsed content exceeds ${MAX_MARKDOWN_CHARS} characters`,
        };
      }
      return emptyDocument(markdown, warnings);
    },
  };
}
