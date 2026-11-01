import { monitorProcessMemory } from "@weaver/core/process/memoryMonitor";
import { fork } from "node:child_process";
import {
  createNativeParser,
  MAX_OCR_WALL_CLOCK_MS,
  type NativeParserDeps,
} from "./index";
import type { DocumentParser, ParseOutcome } from "../parser";
import type { OcrInput, OcrRoute } from "../ocr";

const resourceFailure = (): ParseOutcome => ({
  failureKind: "validation",
  message: "native parser exceeded a resource limit or could not finish",
});

export function createIsolatedNativeParser(
  deps: NativeParserDeps & { timeoutMs?: number },
): DocumentParser {
  const native = createNativeParser(deps);
  return {
    id: native.id,
    version: native.version,
    supports: (mimeType) => native.supports(mimeType),
    async parse(input, signal) {
      signal.throwIfAborted();
      return new Promise<ParseOutcome>((resolve, reject) => {
        const child = fork(new URL("./parserChild.ts", import.meta.url), [], {
          execArgv: [
            "--max-old-space-size=256",
            "--import",
            import.meta.resolve("tsx"),
          ],
          serialization: "advanced",
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: {
            PATH: process.env.PATH,
            NODE_ENV: process.env.NODE_ENV,
            TZ: "UTC",
          },
        });
        const lifetime = new AbortController();
        const providerSignal = AbortSignal.any([signal, lifetime.signal]);
        let outcome: ParseOutcome | undefined;
        let failure: Error | undefined;
        let route: OcrRoute | undefined;
        let finished = false;
        const deadline = setTimeout(
          () => {
            outcome = resourceFailure();
            lifetime.abort();
            child.kill("SIGKILL");
          },
          deps.timeoutMs ??
            (input.mimeType === "application/pdf" ||
            input.mimeType.startsWith("image/")
              ? MAX_OCR_WALL_CLOCK_MS + 60_000
              : 60_000),
        );
        const stopMemory = monitorProcessMemory(
          child,
          768 * 1024 * 1024,
          () => {
            outcome = resourceFailure();
            lifetime.abort();
            child.kill("SIGKILL");
          },
        );
        const abort = () => {
          failure =
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException("Parser cancelled", "AbortError");
          child.kill("SIGKILL");
        };
        signal.addEventListener("abort", abort, { once: true });
        const send = (message: unknown) => {
          if (child.connected)
            child.send(message as object, (error) => {
              if (error) child.kill("SIGKILL");
            });
        };
        child.on(
          "message",
          (message: {
            kind: string;
            id?: number;
            operation?: string;
            input?: OcrInput;
            outcome?: ParseOutcome;
          }) => {
            if (finished || signal.aborted) return;
            if (message.kind === "result") {
              outcome = message.outcome;
              stopMemory();
              child.kill("SIGKILL");
            } else if (message.kind === "ocr") {
              void (async () => {
                if (message.operation === "resolve") {
                  const resolved = await deps.ocr.resolve();
                  if ("failureKind" in resolved) return resolved;
                  route = resolved;
                  await input.onRouteResolved?.(resolved.snapshot);
                  return { snapshot: resolved.snapshot, model: null };
                }
                if (
                  !route ||
                  !message.input ||
                  message.input.png.byteLength > 16 * 1024 * 1024
                )
                  return {
                    failureKind: "validation",
                    message: "invalid OCR request",
                  };
                return deps.ocr.transcribe(
                  route,
                  message.input,
                  providerSignal,
                );
              })().then(
                (value) => send({ kind: "reply", id: message.id, value }),
                () => {
                  send({
                    kind: "reply",
                    id: message.id,
                    value: {
                      failureKind: "provider",
                      message: "OCR request failed",
                    },
                  });
                },
              );
            }
          },
        );
        child.on("error", () => {
          outcome = resourceFailure();
          child.kill("SIGKILL");
        });
        child.once("close", () => {
          finished = true;
          lifetime.abort();
          clearTimeout(deadline);
          stopMemory();
          signal.removeEventListener("abort", abort);
          if (signal.aborted)
            reject(
              failure ?? new DOMException("Parser cancelled", "AbortError"),
            );
          else resolve(outcome ?? resourceFailure());
        });
        const { onRouteResolved: _callback, ...serialized } = input;
        send({
          kind: "parse",
          input: serialized,
          maxOcrPages: deps.maxOcrPages,
        });
        if (signal.aborted) abort();
      });
    },
  };
}
