import { expect, it } from "vitest";
import { createGroupInput } from "./review";

const base = {
  projectId: "00000000-0000-4000-8000-000000000001",
  memberIds: [],
};

it("counts group name length in code points", () => {
  const astral = "\u{1F600}";
  expect(
    createGroupInput.safeParse({ ...base, name: astral.repeat(80) }).success,
  ).toBe(true);
  expect(
    createGroupInput.safeParse({ ...base, name: astral.repeat(81) }).success,
  ).toBe(false);
});
