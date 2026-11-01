import { describe, expect, it } from "vitest";
import { CoreError, isCoreError } from "./errors";

describe("CoreError", () => {
  it("retains stable code, message, and structured details", () => {
    const error = new CoreError("CONFLICT", "stale revision", {
      conflicts: [{ kind: "cell", rowId: "row-1" }],
    });

    expect(isCoreError(error)).toBe(true);
    expect(error.code).toBe("CONFLICT");
    expect(error.details).toEqual({
      conflicts: [{ kind: "cell", rowId: "row-1" }],
    });
  });
});
