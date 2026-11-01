import { expect, it } from "vitest";
import { inspectStructuredArtifactTool } from "./artifactsStructured";

it("defaults to shape only and validates bounded integer depths", () => {
  const target = {
    projectId: "11111111-1111-4111-8111-111111111111",
    filename: "data.json",
  };
  expect(inspectStructuredArtifactTool.inputSchema.parse(target)).toMatchObject(
    { pointer: "", depth: 2, limit: 50, includeSamples: false },
  );
  for (const depth of [-1, 0.5, 6])
    expect(
      inspectStructuredArtifactTool.inputSchema.safeParse({ ...target, depth })
        .success,
    ).toBe(false);
  expect(
    inspectStructuredArtifactTool.inputSchema.safeParse({
      ...target,
      pointer: "/a~1b/~0",
      depth: 0,
    }).success,
  ).toBe(true);
});
