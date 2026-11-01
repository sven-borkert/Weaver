import { describe, expect, it } from "vitest";

import { reciprocalRankFusion } from "./ranking";

describe("reciprocalRankFusion", () => {
  it("combines ranks from separate lists using reciprocal-rank fusion", () => {
    const fused = reciprocalRankFusion(
      [
        [
          { kind: "document", id: "runbook" },
          { kind: "entity", id: "deploy" },
        ],
        [
          { kind: "entity", id: "deploy" },
          { kind: "document", id: "runbook" },
        ],
      ],
      { k: 60 },
    );

    expect(fused.map(({ kind, id }) => ({ kind, id }))).toEqual([
      { kind: "document", id: "runbook" },
      { kind: "entity", id: "deploy" },
    ]);
    expect(fused[0]?.score).toBeCloseTo(1 / 61 + 1 / 62);
    expect(fused[1]?.score).toBeCloseTo(1 / 61 + 1 / 62);
  });

  it("adds exact-match boosts to the fused score", () => {
    const [result] = reciprocalRankFusion(
      [[{ kind: "document", id: "runbook" }]],
      {
        k: 60,
        boosts: [
          { kind: "document", id: "runbook", score: 0.2 },
          { kind: "document", id: "runbook", score: 0.05 },
        ],
      },
    );

    expect(result).toMatchObject({
      kind: "document",
      id: "runbook",
    });
    expect(result?.score).toBeCloseTo(1 / 61 + 0.25);
  });

  it("sorts score ties by kind and then ID", () => {
    const fused = reciprocalRankFusion([
      [{ kind: "entity", id: "z" }],
      [{ kind: "document", id: "b" }],
      [{ kind: "document", id: "a" }],
    ]);

    expect(fused.map(({ kind, id }) => ({ kind, id }))).toEqual([
      { kind: "document", id: "a" },
      { kind: "document", id: "b" },
      { kind: "entity", id: "z" },
    ]);
    expect(fused.every(({ score }) => score === 1 / 61)).toBe(true);
  });
});
