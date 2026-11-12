import { CoreError } from "@weaver/core/errors";
import { describe, expect, it } from "vitest";
import { toTRPCError } from "./coreError";

describe("toTRPCError", () => {
  it("maps core failures without losing details", () => {
    const original = new CoreError(
      "PRECONDITION_FAILED",
      "folder is not empty",
      {
        field: "path",
      },
    );
    const mapped = toTRPCError(original);

    expect(mapped.code).toBe("PRECONDITION_FAILED");
    expect(mapped.cause).toBe(original);
    expect(mapped.cause?.stack).toBe(original.stack);
  });
});
