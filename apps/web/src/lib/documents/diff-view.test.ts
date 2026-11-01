import { describe, expect, it } from "vitest";

import { buildSideBySideRows } from "./diff-view";

describe("buildSideBySideRows", () => {
  it("pairs adjacent deleted and added runs", () => {
    expect(
      buildSideBySideRows([
        { type: "same", text: "before" },
        { type: "del", text: "old one" },
        { type: "del", text: "old two" },
        { type: "add", text: "new one" },
        { type: "same", text: "after" },
      ]),
    ).toEqual([
      {
        left: { type: "same", text: "before" },
        right: { type: "same", text: "before" },
      },
      {
        left: { type: "del", text: "old one" },
        right: { type: "add", text: "new one" },
      },
      { left: { type: "del", text: "old two" }, right: null },
      {
        left: { type: "same", text: "after" },
        right: { type: "same", text: "after" },
      },
    ]);
  });
});
