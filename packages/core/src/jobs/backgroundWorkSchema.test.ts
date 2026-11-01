import { describe, expect, it } from "vitest";
import {
  backgroundWorkListInput,
  backgroundWorkMarkSeenInput,
} from "./backgroundWorkSchema";
const reference = {
  kind: "task",
  id: "4507c3f4-86d6-4558-86d3-69213c6b2646",
  revision: "a".repeat(32),
};
describe("background work inputs", () => {
  it("defaults and bounds list inputs", () => {
    expect(backgroundWorkListInput.parse({})).toEqual({
      audience: "mine",
      view: "all",
      limit: 20,
    });
    for (const input of [
      { limit: 0 },
      { limit: 51 },
      { limit: 1.5 },
      { projectId: "bad" },
      { cursor: "x".repeat(2001) },
      { userId: reference.id },
    ]) {
      expect(backgroundWorkListInput.safeParse(input).success).toBe(false);
    }
  });
  it("accepts only bounded exact personal completion references", () => {
    expect(backgroundWorkMarkSeenInput.parse({ items: [reference] })).toEqual({
      items: [reference],
    });
    for (const items of [
      [],
      Array.from({ length: 51 }, () => reference),
      [{ ...reference, kind: "document" }],
      [{ ...reference, revision: "A".repeat(32) }],
      [{ ...reference, id: "bad" }],
      [{ ...reference, userId: reference.id }],
    ]) {
      expect(backgroundWorkMarkSeenInput.safeParse({ items }).success).toBe(
        false,
      );
    }
    expect(
      backgroundWorkMarkSeenInput.safeParse({
        items: [reference],
        seenAt: new Date().toISOString(),
      }).success,
    ).toBe(false);
  });
});
