export type RankInput = {
  kind: string;
  id: string;
};

export type RankBoost = RankInput & {
  score: number;
};

export type ReciprocalRankFusionOptions = {
  k?: number;
  boosts?: readonly RankBoost[];
};

export type FusedRank = RankInput & {
  score: number;
};

export function reciprocalRankFusion(
  lists: ReadonlyArray<ReadonlyArray<RankInput>>,
  options: ReciprocalRankFusionOptions = {},
): FusedRank[] {
  const k = options.k ?? 60;
  if (!Number.isFinite(k) || k < 0) {
    throw new RangeError("k must be a non-negative finite number");
  }

  const scores = new Map<string, FusedRank>();
  for (const list of lists) {
    for (const [index, item] of list.entries()) {
      const key = rankKey(item);
      const existing = scores.get(key);
      const score = 1 / (k + index + 1);
      if (existing) {
        existing.score += score;
      } else {
        scores.set(key, { ...item, score });
      }
    }
  }

  for (const boost of options.boosts ?? []) {
    const result = scores.get(rankKey(boost));
    if (result) result.score += boost.score;
  }

  return [...scores.values()].sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
    if (left.id !== right.id) return left.id < right.id ? -1 : 1;
    return 0;
  });
}

function rankKey(item: RankInput): string {
  return `${item.kind}\0${item.id}`;
}
