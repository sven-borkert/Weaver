import { describe, expect, it } from "vitest";
import {
  defaultScope,
  deriveScopeDraftState,
  pruneScope,
  scopeLabel,
  snapshotLabel,
  snapshotToRequest,
  toggleScopeProject,
  type ScopeDraftState,
} from "./scopeDraft";

const P = "11111111-1111-4111-8111-111111111111";
const Q = "22222222-2222-4222-8222-222222222222";
const D = "33333333-3333-4333-8333-333333333333";

describe("defaultScope", () => {
  it("prefers the page's document, then table, then project, then all", () => {
    expect(defaultScope({ projectId: P, documentId: D }, null)).toEqual({
      kind: "document",
      projectId: P,
      documentId: D,
    });
    expect(defaultScope({ projectId: P, tableId: D }, null)).toEqual({
      kind: "table",
      projectId: P,
      tableId: D,
    });
    expect(defaultScope({ projectId: P }, null)).toEqual({
      kind: "project",
      projectId: P,
    });
    expect(defaultScope({}, null)).toEqual({ kind: "all" });
  });
  it("uses the pinned project when the page has none", () => {
    expect(defaultScope({}, Q)).toEqual({ kind: "project", projectId: Q });
    expect(defaultScope({ projectId: P, documentId: D }, Q)).toEqual({
      kind: "document",
      projectId: P,
      documentId: D,
    });
  });
});

describe("snapshotToRequest", () => {
  it("round-trips every kind", () => {
    const base = { resolvedAt: "2026-09-03T00:00:00.000Z", truncated: false };
    expect(
      snapshotToRequest({
        ...base,
        kind: "document",
        projectIds: [P],
        documentId: D,
        tableId: null,
      }),
    ).toEqual({ kind: "document", projectId: P, documentId: D });
    expect(
      snapshotToRequest({
        ...base,
        kind: "table",
        projectIds: [P],
        documentId: null,
        tableId: D,
      }),
    ).toEqual({ kind: "table", projectId: P, tableId: D });
    expect(
      snapshotToRequest({
        ...base,
        kind: "project",
        projectIds: [P],
        documentId: null,
        tableId: null,
      }),
    ).toEqual({ kind: "project", projectId: P });
    expect(
      snapshotToRequest({
        ...base,
        kind: "projects",
        projectIds: [P, Q],
        documentId: null,
        tableId: null,
      }),
    ).toEqual({ kind: "projects", projectIds: [P, Q] });
    expect(
      snapshotToRequest({
        ...base,
        kind: "all",
        projectIds: [P],
        documentId: null,
        tableId: null,
      }),
    ).toEqual({ kind: "all" });
  });
});

describe("pruneScope", () => {
  it("drops projects the user can no longer access and falls back to all when none remain", () => {
    expect(pruneScope({ kind: "projects", projectIds: [P, Q] }, [P])).toEqual({
      draft: { kind: "projects", projectIds: [P] },
      dropped: 1,
    });
    expect(pruneScope({ kind: "projects", projectIds: [Q] }, [P])).toEqual({
      draft: { kind: "all" },
      dropped: 1,
    });
    expect(pruneScope({ kind: "project", projectId: Q }, [P])).toEqual({
      draft: { kind: "all" },
      dropped: 1,
    });
    expect(pruneScope({ kind: "all" }, [])).toEqual({
      draft: { kind: "all" },
      dropped: 0,
    });
  });
});

describe("deriveScopeDraftState", () => {
  const base = { resolvedAt: "2026-09-03T00:00:00.000Z", truncated: false };
  const projectsSnapshot = {
    ...base,
    kind: "projects" as const,
    projectIds: [P, Q],
    documentId: null,
    tableId: null,
  };

  it("seeds a brand-new conversation from the page when no snapshot exists yet", () => {
    const state = deriveScopeDraftState(
      null,
      { conversationId: "c1", lastUserSnapshot: null, pinnedProjectId: null },
      { projectId: P, documentId: D },
      null,
    );
    expect(state).toEqual({
      conversationId: "c1",
      draft: { kind: "document", projectId: P, documentId: D },
      seeded: false,
      dropped: 0,
      prunedAgainst: null,
      defaultPin: null,
    });
  });

  it("seeds a brand-new conversation from the pinned project when the page has none", () => {
    const state = deriveScopeDraftState(
      null,
      { conversationId: "c1", lastUserSnapshot: null, pinnedProjectId: Q },
      {},
      null,
    );
    expect(state).toEqual({
      conversationId: "c1",
      draft: { kind: "project", projectId: Q },
      seeded: false,
      dropped: 0,
      prunedAgainst: null,
      defaultPin: Q,
    });
  });

  it("adopts a pinned project that resolves later for a still-unseeded, message-less conversation", () => {
    const unseeded = deriveScopeDraftState(
      null,
      { conversationId: "c1", lastUserSnapshot: null, pinnedProjectId: null },
      {},
      null,
    );
    expect(unseeded.draft).toEqual({ kind: "all" });
    const pinned = deriveScopeDraftState(
      unseeded,
      { conversationId: "c1", lastUserSnapshot: null, pinnedProjectId: Q },
      {},
      null,
    );
    expect(pinned).toEqual({
      conversationId: "c1",
      draft: { kind: "project", projectId: Q },
      seeded: false,
      dropped: 0,
      prunedAgainst: null,
      defaultPin: Q,
    });
  });

  it("does not re-derive the pinned default when the page already determines the draft", () => {
    const seeded = deriveScopeDraftState(
      null,
      { conversationId: "c1", lastUserSnapshot: null, pinnedProjectId: null },
      { projectId: P, documentId: D },
      null,
    );
    const afterPin = deriveScopeDraftState(
      seeded,
      { conversationId: "c1", lastUserSnapshot: null, pinnedProjectId: Q },
      { projectId: P, documentId: D },
      null,
    );
    expect(afterPin).toBe(seeded);
  });

  it("still prefers a snapshot over an already-adopted pin, for the same conversation", () => {
    const pinned = deriveScopeDraftState(
      null,
      { conversationId: "c1", lastUserSnapshot: null, pinnedProjectId: Q },
      {},
      null,
    );
    const withSnapshot = deriveScopeDraftState(
      pinned,
      {
        conversationId: "c1",
        lastUserSnapshot: projectsSnapshot,
        pinnedProjectId: Q,
      },
      {},
      null,
    );
    expect(withSnapshot).toEqual({
      conversationId: "c1",
      draft: { kind: "projects", projectIds: [P, Q] },
      seeded: true,
      dropped: 0,
      prunedAgainst: null,
      defaultPin: Q,
    });
  });

  it("keeps a user edit even once a pin resolves later", () => {
    const unseeded = deriveScopeDraftState(
      null,
      { conversationId: "c1", lastUserSnapshot: null, pinnedProjectId: null },
      {},
      null,
    );
    // Mirrors what useScopeDraft.setDraft does: mark seeded so nothing can
    // clobber a manual choice.
    const edited: ScopeDraftState = {
      ...unseeded,
      draft: { kind: "project", projectId: P },
      seeded: true,
      dropped: 0,
    };
    const afterLatePin = deriveScopeDraftState(
      edited,
      { conversationId: "c1", lastUserSnapshot: null, pinnedProjectId: Q },
      {},
      null,
    );
    expect(afterLatePin).toBe(edited);
  });

  it("seeds directly from the last snapshot when it is already available on first render", () => {
    const state = deriveScopeDraftState(
      null,
      {
        conversationId: "c1",
        lastUserSnapshot: projectsSnapshot,
        pinnedProjectId: null,
      },
      { projectId: P, documentId: D },
      null,
    );
    expect(state).toEqual({
      conversationId: "c1",
      draft: { kind: "projects", projectIds: [P, Q] },
      seeded: true,
      dropped: 0,
      prunedAgainst: null,
      defaultPin: null,
    });
  });

  it("adopts the snapshot once it arrives after the page-based seed, for the same conversation", () => {
    const unseeded = deriveScopeDraftState(
      null,
      { conversationId: "c1", lastUserSnapshot: null, pinnedProjectId: null },
      { projectId: P, documentId: D },
      null,
    );
    const seeded = deriveScopeDraftState(
      unseeded,
      {
        conversationId: "c1",
        lastUserSnapshot: projectsSnapshot,
        pinnedProjectId: null,
      },
      { projectId: P, documentId: D },
      null,
    );
    expect(seeded).toEqual({
      conversationId: "c1",
      draft: { kind: "projects", projectIds: [P, Q] },
      seeded: true,
      dropped: 0,
      prunedAgainst: null,
      defaultPin: null,
    });
  });

  it("does not move an already-seeded conversation's draft when only the page changes", () => {
    const seeded = deriveScopeDraftState(
      null,
      {
        conversationId: "c1",
        lastUserSnapshot: projectsSnapshot,
        pinnedProjectId: null,
      },
      { projectId: P, documentId: D },
      null,
    );
    const afterNav = deriveScopeDraftState(
      seeded,
      {
        conversationId: "c1",
        lastUserSnapshot: projectsSnapshot,
        pinnedProjectId: null,
      },
      { projectId: Q },
      null,
    );
    expect(afterNav).toBe(seeded);
  });

  it("is a no-op (same reference) once seeded and nothing about the conversation changed", () => {
    const seeded = deriveScopeDraftState(
      null,
      { conversationId: "c1", lastUserSnapshot: null, pinnedProjectId: null },
      {},
      null,
    );
    const again = deriveScopeDraftState(
      seeded,
      { conversationId: "c1", lastUserSnapshot: null, pinnedProjectId: null },
      {},
      null,
    );
    expect(again).toBe(seeded);
  });

  it("reseeds fresh from the new page when the conversation changes", () => {
    const first = deriveScopeDraftState(
      null,
      {
        conversationId: "c1",
        lastUserSnapshot: projectsSnapshot,
        pinnedProjectId: null,
      },
      { projectId: P, documentId: D },
      null,
    );
    const second = deriveScopeDraftState(
      first,
      { conversationId: "c2", lastUserSnapshot: null, pinnedProjectId: null },
      { projectId: Q },
      null,
    );
    expect(second).toEqual({
      conversationId: "c2",
      draft: { kind: "project", projectId: Q },
      seeded: false,
      dropped: 0,
      prunedAgainst: null,
      defaultPin: null,
    });
  });

  it("prunes the freshly seeded draft against membership already known at seed time", () => {
    const state = deriveScopeDraftState(
      null,
      {
        conversationId: "c1",
        lastUserSnapshot: projectsSnapshot,
        pinnedProjectId: null,
      },
      {},
      [P],
    );
    expect(state).toEqual({
      conversationId: "c1",
      draft: { kind: "projects", projectIds: [P] },
      seeded: true,
      dropped: 1,
      prunedAgainst: [P],
      defaultPin: null,
    });
  });

  it("prunes again only when the accessible-id list is a new reference", () => {
    const ids = [P, Q];
    const seeded = deriveScopeDraftState(
      null,
      { conversationId: "c1", lastUserSnapshot: null, pinnedProjectId: null },
      {},
      ids,
    );
    // Same reference passed again (e.g. an unrelated re-render): no-op.
    const again = deriveScopeDraftState(
      seeded,
      { conversationId: "c1", lastUserSnapshot: null, pinnedProjectId: null },
      {},
      ids,
    );
    expect(again).toBe(seeded);
  });

  it("drops a project that disappears on a later membership refetch and keeps the note across an unrelated one after", () => {
    const current: ScopeDraftState = {
      conversationId: "c1",
      draft: { kind: "projects", projectIds: [P, Q] },
      seeded: true,
      dropped: 0,
      prunedAgainst: [P, Q],
      defaultPin: null,
    };
    const afterLoss = deriveScopeDraftState(
      current,
      { conversationId: "c1", lastUserSnapshot: null, pinnedProjectId: null },
      {},
      [P],
    );
    expect(afterLoss.draft).toEqual({ kind: "projects", projectIds: [P] });
    expect(afterLoss.dropped).toBe(1);

    // A later refetch with a *new* array reference but the same membership
    // finds nothing new to drop, and the note about the earlier loss stays.
    const unrelatedRefetch = deriveScopeDraftState(
      afterLoss,
      { conversationId: "c1", lastUserSnapshot: null, pinnedProjectId: null },
      {},
      [P],
    );
    expect(unrelatedRefetch.dropped).toBe(1);
    expect(unrelatedRefetch.draft).toEqual({
      kind: "projects",
      projectIds: [P],
    });
  });
});

describe("toggleScopeProject", () => {
  it("adds a project to an empty or non-projects draft", () => {
    expect(toggleScopeProject({ kind: "all" }, P)).toEqual({
      kind: "projects",
      projectIds: [P],
    });
    expect(toggleScopeProject({ kind: "project", projectId: Q }, P)).toEqual({
      kind: "projects",
      projectIds: [P],
    });
  });
  it("removes a project already selected, widening to all once empty", () => {
    expect(
      toggleScopeProject({ kind: "projects", projectIds: [P, Q] }, P),
    ).toEqual({ kind: "projects", projectIds: [Q] });
    expect(
      toggleScopeProject({ kind: "projects", projectIds: [P] }, P),
    ).toEqual({ kind: "all" });
  });
  it("refuses to add past the cap", () => {
    const atCap = { kind: "projects" as const, projectIds: [P, Q] };
    expect(toggleScopeProject(atCap, D, 2)).toEqual(atCap);
  });
});

describe("labels", () => {
  it("describes the draft with names when known", () => {
    expect(
      scopeLabel(
        { kind: "document", projectId: P, documentId: D },
        { document: "Runbook" },
      ),
    ).toBe("Focus on this document · Runbook");
    expect(scopeLabel({ kind: "table", projectId: P, tableId: D }, {})).toBe(
      "Focus on this table",
    );
    expect(
      scopeLabel({ kind: "project", projectId: P }, { project: "Platform" }),
    ).toBe("Project · Platform");
    expect(scopeLabel({ kind: "projects", projectIds: [P, Q] }, {})).toBe(
      "2 projects",
    );
    expect(scopeLabel({ kind: "all" }, { projectCount: 12 })).toBe(
      "All projects (12)",
    );
  });
  it("describes a stored snapshot, flagging truncation", () => {
    const base = {
      resolvedAt: "2026-09-03T00:00:00.000Z",
      documentId: null,
      tableId: null,
    };
    expect(
      snapshotLabel({
        ...base,
        kind: "projects",
        projectIds: [P, Q],
        truncated: false,
      }),
    ).toBe("2 projects");
    expect(
      snapshotLabel({ ...base, kind: "all", projectIds: [P], truncated: true }),
    ).toBe("All projects · limited to 100");
    expect(
      snapshotLabel({
        ...base,
        kind: "document",
        projectIds: [P],
        documentId: D,
        truncated: false,
      }),
    ).toBe("Focus on this document");
  });
});

describe("folder focus", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const draft = {
    kind: "folder" as const,
    projectId,
    resourceType: "document" as const,
    folderPath: ["specs", "api"],
  };
  it("labels, round-trips through a snapshot and prunes with its project", () => {
    expect(scopeLabel(draft, {})).toBe("Folder · Documents / specs / api");
    const snapshot = {
      kind: "folder" as const,
      projectIds: [projectId],
      documentId: null,
      tableId: null,
      folderPath: ["specs", "api"],
      folderResourceType: "document" as const,
      resolvedAt: new Date(0).toISOString(),
      truncated: false,
    };
    expect(snapshotToRequest(snapshot)).toEqual(draft);
    expect(snapshotLabel(snapshot)).toBe("Folder · Documents / specs / api");
    expect(pruneScope(draft, [projectId])).toEqual({ draft, dropped: 0 });
    expect(pruneScope(draft, [])).toEqual({
      draft: { kind: "all" },
      dropped: 1,
    });
  });
});
