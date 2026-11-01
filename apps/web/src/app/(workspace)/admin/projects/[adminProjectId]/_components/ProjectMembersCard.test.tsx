import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  addableCandidates,
  candidateLabel,
  effectiveSelection,
  ProjectMembersCard,
} from "./ProjectMembersCard";

const ADMIN = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";

const members = [
  {
    userId: ADMIN,
    name: "Admin Person",
    email: "admin@weaver.local",
    role: "Owner" as const,
    active: true,
  },
  {
    userId: OWNER,
    name: "Owner Person",
    email: "owner@weaver.local",
    role: "Owner" as const,
    active: false,
  },
];

function render(
  overrides: Partial<Parameters<typeof ProjectMembersCard>[0]> = {},
) {
  return renderToStaticMarkup(
    <ProjectMembersCard
      projectName="Demo Project"
      members={members}
      callerId={ADMIN}
      candidates={[]}
      userSearch=""
      onUserSearchChange={vi.fn()}
      onSetMembership={vi.fn()}
      pending={false}
      {...overrides}
    />,
  );
}

describe("ProjectMembersCard", () => {
  it("lists members with email and marks deactivated accounts", () => {
    const html = render();
    expect(html).toContain("owner@weaver.local");
    expect(html).toContain("Deactivated");
  });

  it("keeps the caller's own row read-only and explains why", () => {
    const html = render();
    expect(html).toContain(
      "You can&#x27;t change your own project membership.",
    );
    expect(html).toContain('aria-label="Remove Owner Person"');
    expect(html).not.toContain('aria-label="Remove Admin Person"');
  });

  it("says when nobody is a member", () => {
    const html = render({ members: [] });
    expect(html).toContain("No members.");
  });
});

describe("add member selection", () => {
  const candidates = [
    { id: ADMIN, name: "Admin Person", email: "admin@weaver.local" },
    { id: OWNER, name: "Owner Person", email: "owner@weaver.local" },
    { id: "u3", name: "Third", email: "third@weaver.local" },
  ];

  it("excludes members and the caller", () => {
    expect(
      addableCandidates(candidates, members, ADMIN).map((u) => u.id),
    ).toEqual(["u3"]);
    expect(addableCandidates(candidates, [], ADMIN).map((u) => u.id)).toEqual([
      OWNER,
      "u3",
    ]);
  });

  it("drops a selection that is no longer offered", () => {
    const available = addableCandidates(candidates, [], ADMIN);
    expect(effectiveSelection("gone", available)).toBe("");
    expect(effectiveSelection("", available)).toBe("");
  });

  it("keeps a selection that is still offered", () => {
    const available = addableCandidates(candidates, [], ADMIN);
    expect(effectiveSelection("u3", available)).toBe("u3");
  });

  it("clears the selection once the user becomes a member", () => {
    const joined = [...members, { ...members[0]!, userId: "u3" }];
    const available = addableCandidates(candidates, joined, ADMIN);
    expect(effectiveSelection("u3", available)).toBe("");
  });

  it("labels deactivated candidates", () => {
    expect(
      candidateLabel({ name: "Old", email: "old@weaver.local", active: false }),
    ).toBe("Old (old@weaver.local) — deactivated");
    expect(
      candidateLabel({ name: "New", email: "new@weaver.local", active: true }),
    ).toBe("New (new@weaver.local)");
  });
});
