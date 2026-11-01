import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  GraphWorkspace,
  focusGraphDestination,
  graphDestinationFocusIdentity,
  graphDrawerStateForLayout,
  restoreGraphDrawerFocus,
} from "./GraphWorkspace";

const focusA = "11111111-1111-4111-8111-111111111111";
const focusB = "22222222-2222-4222-8222-222222222222";

describe("graph workspace responsive drawers", () => {
  it("closes both mobile drawers when the layout becomes desktop", () => {
    expect(
      graphDrawerStateForLayout(false, {
        filtersOpen: true,
        detailsOpen: true,
      }),
    ).toEqual({ filtersOpen: false, detailsOpen: false });
    expect(
      graphDrawerStateForLayout(true, {
        filtersOpen: true,
        detailsOpen: true,
      }),
    ).toEqual({ filtersOpen: true, detailsOpen: true });
  });
});

describe("graph workspace destination focus", () => {
  it("refocuses same-project focus and document destinations but not filter-only replacements", () => {
    const workspace = focusTarget();
    const initialState = {
      focusId: focusA,
      projectIds: ["project-a"],
      entityTypes: [],
      relationTypes: [],
    };
    const initialIdentity = graphDestinationFocusIdentity(initialState);
    let handledIdentity = focusGraphDestination({
      identity: initialIdentity,
      handledIdentity: undefined,
      initialStateResolved: true,
      workspace,
    });

    expect(workspace.focus).toHaveBeenCalledTimes(1);
    const filterIdentity = graphDestinationFocusIdentity({
      ...initialState,
      entityTypes: ["Service"],
      relationTypes: ["DEPENDS_ON"],
    });
    expect(filterIdentity).toBe(initialIdentity);
    handledIdentity = focusGraphDestination({
      identity: filterIdentity,
      handledIdentity,
      initialStateResolved: true,
      workspace,
    });
    expect(workspace.focus).toHaveBeenCalledTimes(1);

    const nextIdentity = graphDestinationFocusIdentity({
      ...initialState,
      focusId: focusB,
    });
    handledIdentity = focusGraphDestination({
      identity: nextIdentity,
      handledIdentity,
      initialStateResolved: true,
      workspace,
    });
    expect(handledIdentity).toBe(nextIdentity);
    expect(workspace.focus).toHaveBeenCalledTimes(2);

    const documentIdentity = graphDestinationFocusIdentity({
      ...initialState,
      focusId: undefined,
      documentId: "33333333-3333-4333-8333-333333333333",
    });
    focusGraphDestination({
      identity: documentIdentity,
      handledIdentity,
      initialStateResolved: true,
      workspace,
    });
    expect(workspace.focus).toHaveBeenCalledTimes(3);
  });

  it("restores a cleared Details selection to the connected workspace", () => {
    const workspace = focusTarget();
    const disconnectedSelection = focusTarget(false);
    const controls = new Map([["entity:removed", disconnectedSelection]]);

    expect(
      restoreGraphDrawerFocus({
        selectionIdentity: undefined,
        outlineControls: controls,
        workspace,
      }),
    ).toBe("workspace");
    expect(
      restoreGraphDrawerFocus({
        selectionIdentity: "entity:removed",
        outlineControls: controls,
        workspace,
      }),
    ).toBe("workspace");
    expect(disconnectedSelection.focus).not.toHaveBeenCalled();
    expect(workspace.focus).toHaveBeenCalledTimes(2);
  });

  it("prefers a connected selected outline control over the workspace", () => {
    const workspace = focusTarget();
    const selected = focusTarget();

    expect(
      restoreGraphDrawerFocus({
        selectionIdentity: "entity:selected",
        outlineControls: new Map([["entity:selected", selected]]),
        workspace,
      }),
    ).toBe("selection");
    expect(selected.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(workspace.focus).not.toHaveBeenCalled();
  });
});

function focusTarget(isConnected = true) {
  return {
    isConnected,
    focus: vi.fn<(options?: FocusOptions) => void>(),
  };
}

it("keeps finder results actionable after the focused entity disappears", () => {
  const noop = () => undefined;
  const markup = renderToStaticMarkup(
    createElement(GraphWorkspace, {
      projectName: "Project",
      urlState: {
        projectIds: [focusA],
        focusId: focusB,
        entityTypes: [],
        relationTypes: [],
      },
      readiness: {
        keyword: "ready",
        semantic: "ready",
        graph: "ready",
        aiConfigured: true,
      },
      projects: [],
      projectsUnavailable: false,
      rawSeedQuery: "Atlas",
      onRawSeedQueryChange: noop,
      seedSearch: {
        entities: [
          {
            entityId: focusA,
            projectId: focusA,
            projectName: "Project",
            canonicalName: "Atlas found",
            entityType: "Product",
            description: null,
            aliases: [],
          },
        ],
        truncated: false,
      },
      seedSearchLoading: false,
      seedSearchFailed: false,
      onRetrySeedSearch: noop,
      documentSeedsLoading: false,
      documentSeedsFailed: false,
      onRetryDocumentSeeds: noop,
      graphState: null,
      neighborhoodLoading: false,
      neighborhoodFailed: false,
      focusNotFound: true,
      onRetryNeighborhood: noop,
      onExpand: noop,
      onRetryExpand: noop,
      onReset: noop,
      detailLoading: false,
      detailFailed: false,
      onRetryDetail: noop,
      onSelect: noop,
      onFocus: noop,
      entityTypeOptions: [],
      relationTypeOptions: [],
      onProjectIdsChange: noop,
      onEntityTypesChange: noop,
      onRelationTypesChange: noop,
      initialStateResolved: true,
      statusAnnouncement: "",
    }),
  );
  expect(markup).toContain("Graph was refreshed; choose an entity again");
  expect(markup).toContain("Atlas found");
  expect(markup).toContain("Focus Atlas found");
});
