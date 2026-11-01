export type ReviewerTarget = { type: "user" | "group"; id: string };
export type ReviewerOption = ReviewerTarget & { label: string; detail: string };

const byLabel = (a: ReviewerOption, b: ReviewerOption) =>
  a.label.localeCompare(b.label) || a.id.localeCompare(b.id);

export function reviewerOptions(
  members: { userId: string; name: string | null; email: string }[],
  groups: { id: string; name: string; members: unknown[] }[],
): ReviewerOption[] {
  const groupOptions = groups.map((group): ReviewerOption => ({
    type: "group",
    id: group.id,
    label: group.name,
    detail: `Group · ${group.members.length} ${group.members.length === 1 ? "member" : "members"}`,
  }));
  const memberOptions = members.map((member): ReviewerOption => ({
    type: "user",
    id: member.userId,
    label: member.name ?? member.email,
    detail: member.email,
  }));
  return [...groupOptions.sort(byLabel), ...memberOptions.sort(byLabel)];
}

export function toggleTarget(
  selected: ReviewerTarget[],
  target: ReviewerTarget,
): ReviewerTarget[] {
  const same = (t: ReviewerTarget) =>
    t.type === target.type && t.id === target.id;
  return selected.some(same)
    ? selected.filter((t) => !same(t))
    : [...selected, target];
}

const targetKey = (target: ReviewerTarget) => `${target.type}:${target.id}`;

/** Keeps only targets still present in `options`; returns the same array when nothing is dropped. */
export function pruneTargets(
  selected: ReviewerTarget[],
  options: ReviewerOption[],
): ReviewerTarget[] {
  const available = new Set(options.map(targetKey));
  const kept = selected.filter((target) => available.has(targetKey(target)));
  return kept.length === selected.length ? selected : kept;
}

export function sameTargets(a: ReviewerTarget[], b: ReviewerTarget[]): boolean {
  const keys = new Set(b.map(targetKey));
  return a.length === b.length && a.every((t) => keys.has(targetKey(t)));
}
