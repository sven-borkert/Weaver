import { expect, it } from "vitest";
import {
  parseTextPosition,
  textPositionString,
  readTextArtifactTool,
} from "./artifactsText";

it("round trips within-line continuations and rejects invalid locations", () => {
  expect(
    parseTextPosition(textPositionString({ line: 12, charOffset: 70001 })),
  ).toEqual({ line: 12, charOffset: 70001 });
  for (const position of ["0:0", "1:-1", "1:NaN", "1:2:3", "Infinity:0"])
    expect(() => parseTextPosition(position)).toThrow();
});

it("bounds line windows and accepts a section with a signed continuation", () => {
  const target = {
    projectId: "11111111-1111-4111-8111-111111111111",
    filename: "notes.md",
  };
  expect(readTextArtifactTool.inputSchema.parse(target).limit).toBe(100);
  expect(
    readTextArtifactTool.inputSchema.safeParse({ ...target, limit: 501 })
      .success,
  ).toBe(false);
  expect(
    readTextArtifactTool.inputSchema.safeParse({
      ...target,
      sectionId: "heading-2",
      cursor: "signed",
    }).success,
  ).toBe(true);
});
