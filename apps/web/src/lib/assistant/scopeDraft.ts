import {
  MAX_SCOPE_PROJECTS,
  type ScopeRequest,
  type ScopeSnapshot,
} from "@weaver/core/assistant/scopeSchema";

export type PageContext = {
  projectId?: string;
  documentId?: string;
  tableId?: string;
};

export function defaultScope(
  page: PageContext,
  pinnedProjectId: string | null,
): ScopeRequest {
  if (page.projectId && page.documentId)
    return {
      kind: "document",
      projectId: page.projectId,
      documentId: page.documentId,
    };
  if (page.projectId && page.tableId)
    return { kind: "table", projectId: page.projectId, tableId: page.tableId };
  if (page.projectId) return { kind: "project", projectId: page.projectId };
  if (pinnedProjectId) return { kind: "project", projectId: pinnedProjectId };
  return { kind: "all" };
}

export function snapshotToRequest(snapshot: ScopeSnapshot): ScopeRequest {
  const first = snapshot.projectIds[0];
  switch (snapshot.kind) {
    case "document":
      return first && snapshot.documentId
        ? {
            kind: "document",
            projectId: first,
            documentId: snapshot.documentId,
          }
        : { kind: "all" };
    case "table":
      return first && snapshot.tableId
        ? { kind: "table", projectId: first, tableId: snapshot.tableId }
        : { kind: "all" };
    case "folder":
      return first && snapshot.folderPath && snapshot.folderResourceType
        ? {
            kind: "folder",
            projectId: first,
            resourceType: snapshot.folderResourceType,
            folderPath: [...snapshot.folderPath],
          }
        : { kind: "all" };
    case "project":
      return first ? { kind: "project", projectId: first } : { kind: "all" };
    case "projects":
      return snapshot.projectIds.length
        ? { kind: "projects", projectIds: [...snapshot.projectIds] }
        : { kind: "all" };
    case "all":
      return { kind: "all" };
  }
}

/** Removes projects the user can no longer access; an empty result widens to `all`. */
export function pruneScope(
  draft: ScopeRequest,
  accessibleProjectIds: readonly string[],
): { draft: ScopeRequest; dropped: number } {
  const ok = new Set(accessibleProjectIds);
  switch (draft.kind) {
    case "projects": {
      const kept = draft.projectIds.filter((id) => ok.has(id));
      const dropped = draft.projectIds.length - kept.length;
      return kept.length
        ? { draft: { kind: "projects", projectIds: kept }, dropped }
        : { draft: { kind: "all" }, dropped };
    }
    case "project":
    case "document":
    case "table":
    case "folder":
      return ok.has(draft.projectId)
        ? { draft, dropped: 0 }
        : { draft: { kind: "all" }, dropped: 1 };
    case "all":
      return { draft, dropped: 0 };
  }
}

/**
 * Toggles a project in/out of a `projects` selection, enforcing the
 * backend's `scopeRequestSchema` cap (`MAX_SCOPE_PROJECTS`, currently 100):
 * once at the cap, adding another id is a no-op rather than exceeding it.
 * An empty result widens to `all` rather than an empty `projects` array,
 * which the server's `min(1)` would reject.
 */
export function toggleScopeProject(
  draft: ScopeRequest,
  projectId: string,
  max: number = MAX_SCOPE_PROJECTS,
): ScopeRequest {
  const selected = new Set(draft.kind === "projects" ? draft.projectIds : []);
  if (selected.has(projectId)) selected.delete(projectId);
  else if (selected.size < max) selected.add(projectId);
  return selected.size
    ? { kind: "projects", projectIds: [...selected] }
    : { kind: "all" };
}

export function folderLabel(
  resourceType: "document" | "table",
  path: readonly string[],
): string {
  return `${resourceType === "table" ? "Tables" : "Documents"} / ${path.join(" / ")}`;
}

export function scopeLabel(
  draft: ScopeRequest,
  names: {
    document?: string;
    table?: string;
    project?: string;
    projectCount?: number;
  },
): string {
  switch (draft.kind) {
    case "document":
      return names.document
        ? `Focus on this document · ${names.document}`
        : "Focus on this document";
    case "table":
      return names.table
        ? `Focus on this table · ${names.table}`
        : "Focus on this table";
    case "folder":
      return `Folder · ${folderLabel(draft.resourceType, draft.folderPath)}`;
    case "project":
      return names.project ? `Project · ${names.project}` : "Project";
    case "projects":
      return `${draft.projectIds.length} project${draft.projectIds.length === 1 ? "" : "s"}`;
    case "all":
      return names.projectCount === undefined
        ? "All projects"
        : `All projects (${names.projectCount})`;
  }
}

export type ScopeDraftState = {
  conversationId: string | null;
  draft: ScopeRequest;
  /** Whether `draft` already reflects `lastUserSnapshot` (vs. still a page/pinned-project default). */
  seeded: boolean;
  /** How many projects the last prune pass dropped; persists until the user acts. */
  dropped: number;
  /** The accessible-project-id list `draft` was last pruned against (by reference), or `null` before the first prune. */
  prunedAgainst: readonly string[] | null;
  /** The pinnedProjectId `draft` was last computed from while still unseeded; meaningless once `seeded` is true. */
  defaultPin: string | null;
};

/**
 * Computes the next `useScopeDraft` state from the previous one plus the
 * latest inputs. Meant to be called on every render (React's documented
 * "adjust state while rendering" pattern), not from a `useEffect` — it is
 * pure and returns `current` back by reference whenever nothing needs to
 * change, so the caller can skip `setState` and React bails out without an
 * extra commit.
 *
 * Two things happen, in order:
 * 1. Seeding: `current: null` (first render) or a changed `conversationId`
 *    always reseeds fresh — from `lastUserSnapshot` if already available,
 *    else from the page/pinned project. For an unchanged conversation:
 *      - a snapshot that arrives later is adopted at most once (`seeded`
 *        flips to `true`, locking the draft for good — nothing arriving
 *        after that, snapshot or pin, may move it again);
 *      - failing that, a `pinnedProjectId` that arrives (or changes) later
 *        is adopted too, since a still-unseeded, message-less conversation
 *        (e.g. one pinned to a project but with `pinnedProjectId` resolving
 *        after the first render) must still land on "the pinned project"
 *        per the seeding order, not get stuck on the page-less `all`
 *        default it had to guess at before the pin was known. This does
 *        *not* set `seeded`, so a snapshot that arrives even later still
 *        wins over an already-adopted pin (it's the more specific signal).
 *    A page change alone never moves an already-seeded draft, matching the
 *    "don't silently move an existing conversation's scope" rule.
 * 2. Pruning: once `accessibleProjectIds` is known, the draft is pruned
 *    against it — but only when that id list is a *new* reference (i.e. a
 *    real membership refetch), so re-running this on every render doesn't
 *    re-derive `dropped` from an already-pruned draft and erase the note.
 */
export function deriveScopeDraftState(
  current: ScopeDraftState | null,
  input: {
    conversationId: string | null;
    lastUserSnapshot: ScopeSnapshot | null;
    pinnedProjectId: string | null;
  },
  page: PageContext,
  accessibleProjectIds: readonly string[] | null,
): ScopeDraftState {
  let seeded: ScopeDraftState;
  if (current?.conversationId !== input.conversationId) {
    seeded = {
      conversationId: input.conversationId,
      draft: input.lastUserSnapshot
        ? snapshotToRequest(input.lastUserSnapshot)
        : defaultScope(page, input.pinnedProjectId),
      seeded: Boolean(input.lastUserSnapshot),
      dropped: 0,
      prunedAgainst: null,
      defaultPin: input.pinnedProjectId,
    };
  } else if (!current.seeded && input.lastUserSnapshot) {
    seeded = {
      conversationId: current.conversationId,
      draft: snapshotToRequest(input.lastUserSnapshot),
      seeded: true,
      dropped: 0,
      prunedAgainst: null,
      defaultPin: current.defaultPin,
    };
  } else if (
    !current.seeded &&
    !page.projectId &&
    input.pinnedProjectId !== current.defaultPin
  ) {
    // Only the page-less branch of `defaultScope` ever consults the pin, so
    // this is skipped whenever the page already determines the draft —
    // that avoids rebuilding an equal-value draft (and losing `dropped`/
    // `prunedAgainst` for nothing) every time the pin resolves.
    seeded = {
      conversationId: current.conversationId,
      draft: defaultScope(page, input.pinnedProjectId),
      seeded: false,
      dropped: 0,
      prunedAgainst: null,
      defaultPin: input.pinnedProjectId,
    };
  } else {
    seeded = current;
  }

  if (!accessibleProjectIds || accessibleProjectIds === seeded.prunedAgainst) {
    return seeded;
  }
  const pruned = pruneScope(seeded.draft, accessibleProjectIds);
  return {
    ...seeded,
    draft: pruned.draft,
    dropped: pruned.dropped !== 0 ? pruned.dropped : seeded.dropped,
    prunedAgainst: accessibleProjectIds,
  };
}

export function snapshotLabel(snapshot: ScopeSnapshot): string {
  switch (snapshot.kind) {
    case "document":
      return "Focus on this document";
    case "table":
      return "Focus on this table";
    case "folder":
      return snapshot.folderPath && snapshot.folderResourceType
        ? `Folder · ${folderLabel(snapshot.folderResourceType, snapshot.folderPath)}`
        : "Folder";
    case "project":
      return "Project";
    case "projects":
      return `${snapshot.projectIds.length} project${snapshot.projectIds.length === 1 ? "" : "s"}`;
    case "all":
      return snapshot.truncated
        ? "All projects · limited to 100"
        : "All projects";
  }
}
