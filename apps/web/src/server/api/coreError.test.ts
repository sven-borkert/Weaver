import { CoreError } from "@weaver/core/errors";
import { describe, expect, it } from "vitest";
import { toTRPCError } from "./coreError";

describe("toTRPCError", () => {
  it("maps core failures without losing details", () => {
    const mapped = toTRPCError(
      new CoreError("PRECONDITION_FAILED", "folder is not empty", {
        field: "path",
      }),
    );

    expect(mapped.code).toBe("PRECONDITION_FAILED");
    expect(mapped.cause).toEqual({ field: "path" });
  });
});
