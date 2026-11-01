import { describe, expect, it } from "vitest";

import { extractionResponseSchema } from "@weaver/core/knowledge/extraction";

import { graphNeighborhoodInput } from "~/server/api/schemas/graph";

import { graphHref, parseGraphUrlState } from "./graphUrl";

const routeProjectId = "11111111-1111-4111-8111-111111111111";
const focusId = "22222222-2222-4222-8222-222222222222";
const documentId = "33333333-3333-4333-8333-333333333333";

function uuid(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

describe("graph URL state", () => {
  it("gives a valid focus precedence and serializes normalized filters canonically", () => {
    const state = parseGraphUrlState(
      {
        focus: focusId,
        document: documentId,
        project: [routeProjectId, routeProjectId, "invalid"],
        entityType: [" Service ", "Person"],
        relationType: ["DEPENDS_ON", ""],
      },
      routeProjectId,
    );

    expect(state).toEqual({
      focusId,
      documentId: undefined,
      projectIds: [routeProjectId],
      entityTypes: ["Person", "Service"],
      relationTypes: ["DEPENDS_ON"],
    });
    expect(graphHref(routeProjectId, state)).toBe(
      `/projects/${routeProjectId}/graph?focus=${focusId}&entityType=Person&entityType=Service&relationType=DEPENDS_ON`,
    );
  });

  it("keeps a valid document when focus is invalid and defaults invalid project scope", () => {
    const state = parseGraphUrlState(
      {
        focus: "invalid",
        document: [documentId, focusId],
        project: ["invalid"],
      },
      routeProjectId,
    );

    expect(state).toEqual({
      focusId: undefined,
      documentId,
      projectIds: [routeProjectId],
      entityTypes: [],
      relationTypes: [],
    });
    expect(graphHref(routeProjectId, state)).toBe(
      `/projects/${routeProjectId}/graph?document=${documentId}`,
    );
  });

  it("deduplicates, sorts, validates, and caps repeated values", () => {
    const projectIds = Array.from({ length: 55 }, (_, index) =>
      uuid(55 - index),
    );
    const entityTypes = Array.from(
      { length: 25 },
      (_, index) => ` Type ${String(25 - index).padStart(2, "0")} `,
    );
    const relationTypes = Array.from(
      { length: 25 },
      (_, index) => ` REL ${String(25 - index).padStart(2, "0")} `,
    );

    const state = parseGraphUrlState(
      {
        project: [...projectIds, uuid(1), "not-a-uuid"],
        entityType: [...entityTypes, "Type 01", "", "x".repeat(201)],
        relationType: [...relationTypes, "REL 01", "   ", "x".repeat(201)],
      },
      routeProjectId,
    );

    expect(state.projectIds).toEqual(
      Array.from({ length: 50 }, (_, index) => uuid(index + 1)),
    );
    expect(state.entityTypes).toEqual(
      Array.from(
        { length: 20 },
        (_, index) => `Type ${String(index + 1).padStart(2, "0")}`,
      ),
    );
    expect(state.relationTypes).toEqual(
      Array.from(
        { length: 20 },
        (_, index) => `REL ${String(index + 1).padStart(2, "0")}`,
      ),
    );
  });

  it("orders document, project, entity, and relation parameters canonically", () => {
    const otherProjectId = "44444444-4444-4444-8444-444444444444";

    expect(
      graphHref(routeProjectId, {
        documentId,
        projectIds: [otherProjectId, routeProjectId],
        entityTypes: ["Service API", "Person"],
        relationTypes: ["USES / CALLS"],
      }),
    ).toBe(
      `/projects/${routeProjectId}/graph?document=${documentId}&project=${routeProjectId}&project=${otherProjectId}&entityType=Person&entityType=Service+API&relationType=USES+%2F+CALLS`,
    );
  });
});

describe("type-name bound shared with extraction", () => {
  it("round-trips every type extraction accepts and drops longer ones", () => {
    for (const type of ["x".repeat(200), "😀".repeat(100)]) {
      expect(
        extractionResponseSchema.safeParse({
          entities: [
            {
              key: "a",
              name: "A",
              type,
              aliases: [],
              description: null,
              mentionText: "A",
              confidence: 1,
            },
          ],
          relations: [],
        }).success,
      ).toBe(true);
      const state = parseGraphUrlState({ entityType: type }, routeProjectId);
      expect(state.entityTypes).toEqual([type]);
      expect(
        graphNeighborhoodInput.safeParse({
          entityId: focusId,
          entityTypes: [type],
        }).success,
      ).toBe(true);
    }
    expect(
      parseGraphUrlState({ entityType: "x".repeat(201) }, routeProjectId)
        .entityTypes,
    ).toEqual([]);
  });
});
