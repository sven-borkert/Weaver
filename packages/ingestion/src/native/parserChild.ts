import { createNativeParser } from "./index";
import { MAX_MARKDOWN_CHARS } from "@weaver/core/documents/limits";
import { draftTableIssue } from "@weaver/core/ingestion/draftTable";
import type { ParseInput } from "../parser";
import type { OcrClient } from "../ocr";

let requestId = 0;
const pending = new Map<number, (value: unknown) => void>();
const request = (operation: string, input?: unknown) =>
  new Promise<unknown>((resolve) => {
    const id = ++requestId;
    pending.set(id, resolve);
    process.send?.({ kind: "ocr", id, operation, input });
  });
let started = false;
process.on(
  "message",
  (message: {
    kind: string;
    id?: number;
    value?: unknown;
    input?: ParseInput;
    maxOcrPages?: number;
  }) => {
    if (message.kind === "reply" && message.id !== undefined) {
      pending.get(message.id)?.(message.value);
      pending.delete(message.id);
    } else if (message.kind === "parse" && message.input && !started) {
      started = true;
      const ocr: OcrClient = {
        resolve: () => request("resolve") as ReturnType<OcrClient["resolve"]>,
        transcribe: (_route, input) =>
          request("transcribe", input) as ReturnType<OcrClient["transcribe"]>,
      };
      void createNativeParser({ ocr, maxOcrPages: message.maxOcrPages ?? 0 })
        .parse(
          { ...message.input, bytes: Buffer.from(message.input.bytes) },
          new AbortController().signal,
        )
        .then(
          (outcome) => {
            if (!("failureKind" in outcome)) {
              const issue =
                outcome.markdown.length > MAX_MARKDOWN_CHARS
                  ? "Parsed content exceeds the document size limit"
                  : outcome.tables
                      .map((table) =>
                        draftTableIssue(
                          table.columns.map((name) => ({ name, type: "text" })),
                          table.rows,
                        ),
                      )
                      .find(Boolean);
              if (issue) {
                process.send?.({
                  kind: "result",
                  outcome: { failureKind: "validation", message: issue },
                });
                return;
              }
              outcome.warnings = outcome.warnings
                .slice(0, 100)
                .map((warning) => warning.slice(0, 500));
            }
            process.send?.({ kind: "result", outcome });
          },
          () => process.exit(1),
        );
    }
  },
);
process.on("disconnect", () => process.exit(0));
