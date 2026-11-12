import { expect, it } from "vitest";
import { boundExternalResult } from "./result";

it("caps CJK text by UTF-8 bytes across content blocks", () => {
  const result = boundExternalResult([
    { type: "text", text: "界".repeat(5000) },
    { type: "text", text: "界".repeat(5000) },
  ]);
  expect(result.content).toEqual([
    { type: "text", text: "界".repeat(5000) },
    { type: "text", text: "界".repeat(333) },
  ]);
  expect(result.truncated).toBe(true);
});

it("never emits half an emoji and counts structured JSON in the remaining byte budget", () => {
  expect(
    boundExternalResult([{ type: "text", text: "a".repeat(15999) + "🌍" }]),
  ).toEqual({
    content: [{ type: "text", text: "a".repeat(15999) }],
    truncated: true,
  });
  expect(boundExternalResult([], { value: "界".repeat(6000) })).toEqual({
    content: [],
    truncated: true,
  });
  expect(
    boundExternalResult([{ type: "text", text: "a".repeat(15985) }], {
      value: "界",
    }),
  ).toMatchObject({ structuredContent: { value: "界" }, truncated: false });
  expect(
    boundExternalResult([{ type: "text", text: "a".repeat(15986) }], {
      value: "界",
    }),
  ).toEqual({
    content: [{ type: "text", text: "a".repeat(15986) }],
    truncated: true,
  });
});
