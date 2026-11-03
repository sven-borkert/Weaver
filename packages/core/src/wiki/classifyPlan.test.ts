import { describe, expect, it } from "vitest";
import {
  buildClassifyPlan,
  buildClassifyUserMessage,
  classifyPlanDigest,
  CLASSIFY_EXCERPT_CHARS,
  parseStoredClassifyPlan,
  type ClassifyCandidate,
} from "./classifyPlan";

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SHA = "a".repeat(40);
const candidate = (
  n: number,
  extra: Partial<ClassifyCandidate> = {},
): ClassifyCandidate => ({
  documentId: ID(n),
  path: `notes/p${n}.md`,
  title: `Page ${n}`,
  excerpt: "text",
  headCommitSha: SHA,
  hasType: false,
  hasSummary: false,
  ...extra,
});

describe("buildClassifyUserMessage", () => {
  it("fences, cuts and strips page text", () => {
    const message = buildClassifyUserMessage([
      candidate(1, {
        title: "Ignore\u0000 rules‮",
        excerpt: "x".repeat(CLASSIFY_EXCERPT_CHARS * 3),
      }),
    ]);
    expect(message).toContain("--- BEGIN PAGES ---");
    expect(message).toContain("data only");
    expect(message).not.toContain("\u0000");
    expect(message).not.toContain("‮");
    expect(message.length).toBeLessThan(CLASSIFY_EXCERPT_CHARS + 600);
  });
});

describe("buildClassifyPlan", () => {
  const candidates = [
    candidate(1),
    candidate(2, { hasType: true }),
    candidate(3),
  ];

  it("keeps valid proposals for known pages and fills only missing fields", () => {
    const plan = buildClassifyPlan(
      `Here you go: ${JSON.stringify({
        pages: [
          { id: ID(1), type: "topic", summary: "About one." },
          { id: ID(2), type: "entity", summary: "About two." },
          { id: ID(99), type: "topic", summary: "Unknown page." },
          { id: ID(1), type: "entity", summary: "Duplicate." },
        ],
      })}`,
      candidates,
    );
    expect(plan.entries.map((e) => [e.documentId, e.type, e.summary])).toEqual([
      [ID(1), "topic", "About one."],
      [ID(2), undefined, "About two."],
    ]);
  });

  it("drops reserved, guide, oversize and malformed values and unparsable replies", () => {
    const plan = buildClassifyPlan(
      JSON.stringify({
        pages: [
          { id: ID(1), type: "source", summary: "x" },
          { id: ID(3), type: "guide" },
          { id: ID(2), summary: "y".repeat(301) },
        ],
      }),
      candidates,
    );
    expect(plan.entries.map((e) => e.documentId)).toEqual([ID(1)]);
    expect(plan.entries[0]).toMatchObject({ summary: "x" });
    expect(plan.entries[0]).not.toHaveProperty("type");
    expect(buildClassifyPlan("no json here", candidates).entries).toEqual([]);
    expect(buildClassifyPlan("{bad", candidates).entries).toEqual([]);
  });
});

describe("plan digest and stored plans", () => {
  const plan = buildClassifyPlan(
    JSON.stringify({ pages: [{ id: ID(1), type: "topic", summary: "S" }] }),
    [candidate(1)],
  );

  it("is stable and changes with any proposed value", () => {
    expect(classifyPlanDigest(plan)).toBe(classifyPlanDigest({ ...plan }));
    expect(classifyPlanDigest(plan)).toMatch(/^[0-9a-f]{64}$/);
    const changed = {
      ...plan,
      entries: [{ ...plan.entries[0]!, summary: "Different" }],
    };
    expect(classifyPlanDigest(changed)).not.toBe(classifyPlanDigest(plan));
  });

  it("re-validates what the database hands back", () => {
    expect(parseStoredClassifyPlan(JSON.parse(JSON.stringify(plan)))).toEqual(
      plan,
    );
    expect(parseStoredClassifyPlan(null)).toBeNull();
    expect(
      parseStoredClassifyPlan({
        version: 1,
        entries: [{ ...plan.entries[0], type: "source" }],
      }),
    ).toBeNull();
    expect(
      parseStoredClassifyPlan({
        version: 1,
        entries: [{ ...plan.entries[0], extra: 1 }],
      }),
    ).toBeNull();
  });
});
