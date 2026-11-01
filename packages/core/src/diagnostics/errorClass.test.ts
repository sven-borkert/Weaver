import { describe, expect, it } from "vitest";
import { AiProviderError } from "../ai/types";
import { CoreError } from "../errors";
import { safeErrorClass } from "./errorClass";

describe("safeErrorClass", () => {
  it("returns allowlisted class names and hides everything else", () => {
    expect(safeErrorClass(new TypeError("private"))).toBe("TypeError");
    expect(safeErrorClass(new CoreError("NOT_FOUND"))).toBe("CoreError");
    expect(
      safeErrorClass(
        new AiProviderError("down", { kind: "provider", retryable: true }),
      ),
    ).toBe("AiProviderError");
    expect(safeErrorClass(new DOMException("slow", "TimeoutError"))).toBe(
      "TimeoutError",
    );
    const custom = new Error("private");
    custom.name = "PrismaClientKnownRequestError";
    expect(safeErrorClass(custom)).toBe("Error");
    expect(safeErrorClass("boom")).toBe("UnknownError");
    const hostile = new Error("private");
    Object.defineProperty(hostile, "name", {
      get() {
        throw new Error("no");
      },
    });
    expect(safeErrorClass(hostile)).toBe("Error");
  });
});
