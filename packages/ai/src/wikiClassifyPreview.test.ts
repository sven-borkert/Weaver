import { describe, expect, it } from "vitest";
import { buildClassifyUserMessage } from "@weaver/core/wiki/classifyPlan";
import { fitClassifyCandidates } from "./wikiClassifyPreview";

const candidates = Array.from({ length: 10 }, (_, n) => ({
  documentId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  path: `p${n}.md`,
  title: `Page ${n}`,
  excerpt: "e".repeat(500),
  headCommitSha: "a".repeat(40),
  hasType: false,
  hasSummary: false,
}));

describe("fitClassifyCandidates", () => {
  it("keeps the largest prefix whose message fits the budget", () => {
    const size = (n: number) =>
      Buffer.byteLength(buildClassifyUserMessage(candidates.slice(0, n)));
    expect(fitClassifyCandidates(candidates, size(10))).toHaveLength(10);
    expect(fitClassifyCandidates(candidates, size(4))).toHaveLength(4);
    expect(fitClassifyCandidates(candidates, size(4) + 5)).toHaveLength(4);
    expect(fitClassifyCandidates(candidates, 10)).toHaveLength(0);
    expect(fitClassifyCandidates([], 1_000)).toEqual([]);
  });
});
