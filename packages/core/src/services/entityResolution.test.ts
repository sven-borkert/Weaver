import { describe, expect, it } from "vitest";

import { resolveEntityCandidates } from "./entityResolution";

const existing = [
  {
    id: "entity-acme",
    entityType: "Organization",
    canonicalName: "ACME GmbH",
    normalizedName: "acme gmbh",
    aliases: ["Acme"],
  },
  {
    id: "entity-atlas",
    entityType: "Product",
    canonicalName: "Atlas Platform",
    normalizedName: "atlas platform",
    aliases: ["Atlas"],
  },
];

describe("resolveEntityCandidates", () => {
  it("reuses one compatible normalized canonical-name match", () => {
    expect(
      resolveEntityCandidates(existing, {
        name: "  Acme  GmbH ",
        type: "organization",
      }),
    ).toEqual(existing[0]);
  });

  it("reuses one compatible known-alias match", () => {
    expect(
      resolveEntityCandidates(existing, {
        name: "ＡＴＬＡＳ",
        type: "Product",
      }),
    ).toEqual(existing[1]);
  });

  it("does not reuse the same name with an incompatible type", () => {
    expect(
      resolveEntityCandidates(existing, {
        name: "ACME GmbH",
        type: "Person",
      }),
    ).toBeNull();
  });

  it("does not speculate when one alias matches multiple entities", () => {
    expect(
      resolveEntityCandidates(
        [
          ...existing,
          {
            id: "entity-atlas-program",
            entityType: "Product",
            canonicalName: "Atlas Program",
            normalizedName: "atlas program",
            aliases: ["Atlas"],
          },
        ],
        { name: "Atlas", type: "Product" },
      ),
    ).toBeNull();
  });
});

it("prefers the exact canonical identity over ambiguous aliases", () => {
  const exact = {
    id: "exact",
    entityType: "Product",
    canonicalName: "Atlas",
    normalizedName: "atlas",
    aliases: [],
  };
  expect(
    resolveEntityCandidates([...existing, exact], {
      name: "Atlas",
      type: "Product",
    }),
  ).toEqual(exact);
});

it("does not merge an alias when the candidate scan overflowed", () => {
  const existing = [
    {
      id: "person-a",
      entityType: "person",
      canonicalName: "Alice",
      normalizedName: "alice",
      aliases: ["shared"],
    },
  ];
  expect(
    resolveEntityCandidates(
      existing,
      { name: "shared", type: "person" },
      { complete: false },
    ),
  ).toBeNull();
});
