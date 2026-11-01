import { describe, expect, it } from "vitest";

import {
  pruneTargets,
  reviewerOptions,
  sameTargets,
  toggleTarget,
} from "./reviewer-options";

const u1 = "11111111-1111-1111-1111-111111111111";
const u2 = "22222222-2222-2222-2222-222222222222";
const g1 = "33333333-3333-3333-3333-333333333333";

describe("reviewerOptions", () => {
  it("lists groups before members, each sorted by label", () => {
    const options = reviewerOptions(
      [
        { userId: u1, name: "Zed", email: "zed@example.test" },
        { userId: u2, name: "Ada", email: "ada@example.test" },
      ],
      [
        { id: g1, name: "Legal", members: [] },
        { id: "g0", name: "Admins", members: [] },
      ],
    );
    expect(options.map((o) => `${o.type}:${o.label}`)).toEqual([
      "group:Admins",
      "group:Legal",
      "user:Ada",
      "user:Zed",
    ]);
  });

  it("labels a member without a name by email", () => {
    const [option] = reviewerOptions(
      [{ userId: u1, name: null, email: "anon@example.test" }],
      [],
    );
    expect(option).toEqual({
      type: "user",
      id: u1,
      label: "anon@example.test",
      detail: "anon@example.test",
    });
  });

  it("describes groups by member count and members by email", () => {
    const options = reviewerOptions(
      [{ userId: u1, name: "Ada", email: "ada@example.test" }],
      [
        { id: g1, name: "Legal", members: [1, 2, 3] },
        { id: "g2", name: "Solo", members: [1] },
      ],
    );
    expect(options.map((o) => o.detail)).toEqual([
      "Group · 3 members",
      "Group · 1 member",
      "ada@example.test",
    ]);
  });
});

describe("toggleTarget", () => {
  it("adds an absent target", () => {
    const a = { type: "user", id: u1 } as const;
    const b = { type: "group", id: g1 } as const;
    expect(toggleTarget([a], b)).toEqual([a, b]);
  });

  it("removes a present target, comparing type and id", () => {
    const a = { type: "user", id: u1 } as const;
    const b = { type: "group", id: u1 } as const;
    expect(toggleTarget([a, b], { type: "user", id: u1 })).toEqual([b]);
  });
});

describe("pruneTargets", () => {
  const options = reviewerOptions(
    [{ userId: u1, name: "Ada", email: "ada@example.test" }],
    [{ id: g1, name: "Legal", members: [] }],
  );

  it("drops targets that are no longer options", () => {
    expect(
      pruneTargets(
        [
          { type: "group", id: g1 },
          { type: "group", id: "gone" },
          { type: "user", id: u2 },
          { type: "user", id: u1 },
        ],
        options,
      ),
    ).toEqual([
      { type: "group", id: g1 },
      { type: "user", id: u1 },
    ]);
  });

  it("distinguishes users from groups with the same id", () => {
    expect(pruneTargets([{ type: "user", id: g1 }], options)).toEqual([]);
  });

  it("returns the same array when nothing is dropped", () => {
    const selected = [{ type: "group" as const, id: g1 }];
    expect(pruneTargets(selected, options)).toBe(selected);
  });
});

describe("sameTargets", () => {
  it("ignores order but not membership", () => {
    const a = { type: "user" as const, id: u1 };
    const b = { type: "group" as const, id: g1 };
    expect(sameTargets([a, b], [b, a])).toBe(true);
    expect(sameTargets([a], [a, b])).toBe(false);
    expect(sameTargets([a], [{ type: "group", id: u1 }])).toBe(false);
  });
});
