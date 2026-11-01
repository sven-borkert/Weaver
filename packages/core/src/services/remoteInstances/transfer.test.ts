import { describe, expect, it } from "vitest";
import { TRANSFER_BODY_MAX_BYTES } from "./receive";
import { transferRequestBody } from "./transfer";

describe("transferRequestBody", () => {
  it("serialises the payload once", () => {
    expect(transferRequestBody({ title: "T", rows: [] })).toBe(
      '{"title":"T","rows":[]}',
    );
  });

  it("refuses a payload larger than B accepts before any request", () => {
    expect(() =>
      transferRequestBody({ markdown: "x".repeat(TRANSFER_BODY_MAX_BYTES) }),
    ).toThrow(
      expect.objectContaining({
        code: "BAD_REQUEST",
        message: "This item is too large to send",
      }),
    );
  });
});
