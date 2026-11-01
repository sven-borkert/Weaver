import { describe, expect, it } from "vitest";

import { MAX_TOOL_OUTPUT_CHARS } from "../../contract";
import { pagedOutput } from "./paging";

describe("pagedOutput", () => {
  it("keeps the complete serialized envelope within the output limit", () => {
    const page = pagedOutput(
      {
        items: [
          { id: "first", value: "a".repeat(8_000) },
          { id: "second", value: "b".repeat(8_000) },
        ],
        nextCursor: "service-cursor",
      },
      (item) => `cursor:${item.id}`,
    );

    expect(page.items.map((item) => item.id)).toEqual(["first"]);
    expect(page.nextCursor).toBe("cursor:first");
    expect(page.truncated).toBe(true);
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(
      MAX_TOOL_OUTPUT_CHARS,
    );
  });

  it("retains the service cursor when every item fits", () => {
    expect(
      pagedOutput(
        { items: [{ id: "first" }], nextCursor: "service-cursor" },
        (item) => `cursor:${item.id}`,
      ),
    ).toEqual({
      items: [{ id: "first" }],
      nextCursor: "service-cursor",
      truncated: false,
    });
  });

  it("rejects a first row that cannot fit instead of returning a looping cursor", () => {
    expect(() =>
      pagedOutput(
        {
          items: [
            { id: "oversized", value: "x".repeat(MAX_TOOL_OUTPUT_CHARS) },
          ],
          nextCursor: null,
        },
        (item) => `cursor:${item.id}`,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "INTERNAL",
        message: "page item exceeds tool output limit",
      }),
    );
  });
});
