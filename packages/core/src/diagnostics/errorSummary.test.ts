import { describe, expect, it } from "vitest";
import { summarizeError } from "./errorSummary";

describe("summarizeError", () => {
  it("captures name, message, code, errno, syscall, hostname, and capped stack frames", () => {
    const error = Object.assign(
      new Error("connect ECONNREFUSED 100.64.0.1:443"),
      {
        code: "ECONNREFUSED",
        errno: -61,
        syscall: "connect",
        hostname: "litellm.example",
      },
    );
    const summary = summarizeError(error);
    expect(summary).toMatchObject({
      name: "Error",
      message: "connect ECONNREFUSED 100.64.0.1:443",
      code: "ECONNREFUSED",
      errno: -61,
      syscall: "connect",
      hostname: "litellm.example",
    });
    expect(summary.stack).toBeDefined();
    expect(summary.stack!.split("\n").length).toBeLessThanOrEqual(5);
    expect(summary.stack!.length).toBeLessThanOrEqual(1_000);
    expect(
      summary.stack!.split("\n").every((line) => line.startsWith("at ")),
    ).toBe(true);
  });

  it("nests causes at most three levels deep and takes the first aggregate error", () => {
    const deepest = new Error("level four");
    const third = new Error("level three", { cause: deepest });
    const second = new AggregateError(
      [third, new Error("ignored")],
      "level two",
    );
    const top = new TypeError("fetch failed", { cause: second });
    const summary = summarizeError(top);
    expect(summary.cause?.message).toBe("level two");
    expect(summary.cause?.cause?.message).toBe("level three");
    expect(summary.cause?.cause?.cause).toBeUndefined();
  });

  it("redacts secrets and caps the message", () => {
    expect(summarizeError(new Error("Bearer abc123")).message).toBe(
      "[redacted]",
    );
    const long = summarizeError(new Error(`a\n\n   b ${"x".repeat(600)}`));
    expect(long.message.length).toBeLessThanOrEqual(500);
    expect(long.message.startsWith("a b x")).toBe(true);
  });

  it("tolerates non-errors, throwing accessors, and self-referential causes", () => {
    expect(summarizeError("plain string")).toEqual({
      name: "UnknownError",
      message: "plain string",
    });
    const hostile = new Error("hostile");
    Object.defineProperty(hostile, "code", {
      get() {
        throw new Error("no");
      },
    });
    (hostile as { cause?: unknown }).cause = hostile;
    const summary = summarizeError(hostile);
    expect(summary).toMatchObject({ name: "Error", message: "hostile" });
    expect(summary.code).toBeUndefined();
    expect(summary.cause).toBeUndefined();
  });

  it("omits stack, errno and cause when absent and caps a long name", () => {
    const named = new Error("x");
    named.name = "N".repeat(120);
    named.stack = undefined;
    const summary = summarizeError(named);
    expect(summary.name.length).toBeLessThanOrEqual(80);
    expect(summary.stack).toBeUndefined();
    expect(summary.errno).toBeUndefined();
  });
});
