import { describe, expect, it } from "vitest";
import { runStateCopy } from "./runErrorCopy";

describe("runStateCopy", () => {
  it("walks queued → waiting → thinking → streaming", () => {
    expect(
      runStateCopy({
        status: "queued",
        hasText: false,
        queuedForMs: 0,
        errorCode: null,
        retrying: false,
      }),
    ).toEqual({ phase: "queued", label: "Queued" });
    expect(
      runStateCopy({
        status: "queued",
        hasText: false,
        queuedForMs: 10_001,
        errorCode: null,
        retrying: false,
      }),
    ).toEqual({ phase: "waiting", label: "Waiting for a worker…" });
    expect(
      runStateCopy({
        status: "running",
        hasText: false,
        queuedForMs: 0,
        errorCode: null,
        retrying: false,
      }),
    ).toEqual({ phase: "thinking", label: "Thinking" });
    expect(
      runStateCopy({
        status: "running",
        hasText: true,
        queuedForMs: 0,
        errorCode: null,
        retrying: false,
      }),
    ).toEqual({ phase: "streaming", label: null });
    expect(
      runStateCopy({
        status: "cancelling",
        hasText: true,
        queuedForMs: 0,
        errorCode: null,
        retrying: false,
      }),
    ).toEqual({ phase: "cancelling", label: "Cancelling…" });
  });

  it("maps failure codes to the spec copy, retrying or not", () => {
    const failed = (errorCode: string, retrying: boolean) =>
      runStateCopy({
        status: retrying ? "running" : "failed",
        hasText: false,
        queuedForMs: 0,
        errorCode,
        retrying,
      }).label;
    expect(failed("PROVIDER_UNAVAILABLE", false)).toBe(
      "The model didn't respond. Try again.",
    );
    expect(failed("RATE_LIMITED", true)).toBe("The model is busy. Retrying…");
    expect(failed("RATE_LIMITED", false)).toBe(
      "The model is busy. Try again shortly.",
    );
    expect(failed("WORKER_LOST", true)).toBe(
      "The run was interrupted and is being retried.",
    );
    expect(failed("WORKER_LOST", false)).toBe(
      "The run was interrupted and could not be retried.",
    );
    expect(failed("SOMETHING_ELSE", false)).toBe(
      "The assistant couldn't finish this answer.",
    );
  });

  it("labels terminal cancelled and completed", () => {
    expect(
      runStateCopy({
        status: "cancelled",
        hasText: true,
        queuedForMs: 0,
        errorCode: null,
        retrying: false,
      }),
    ).toEqual({ phase: "cancelled", label: "Cancelled" });
    expect(
      runStateCopy({
        status: "completed",
        hasText: true,
        queuedForMs: 0,
        errorCode: null,
        retrying: false,
      }),
    ).toEqual({ phase: "completed", label: null });
  });
});
