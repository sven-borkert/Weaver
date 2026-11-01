"use client";

import { useMemo, useState } from "react";
import type {
  ScopeRequest,
  ScopeSnapshot,
} from "@weaver/core/assistant/scopeSchema";
import { usePageContext } from "~/lib/assistant/pageContext";
import {
  deriveScopeDraftState,
  type ScopeDraftState,
} from "~/lib/assistant/scopeDraft";
import { api } from "~/trpc/react";

/**
 * The scope the next message will use (spec §6). Initialised from the last
 * user message's snapshot, else from the page; pruned when membership
 * shrinks. The seeding/pruning decision itself lives in
 * `deriveScopeDraftState` (~/lib/assistant/scopeDraft.ts) so it can be
 * unit-tested directly — this hook applies it during render (React's
 * documented "adjust state while rendering" pattern) rather than from a
 * `useEffect`, since `deriveScopeDraftState` is pure and returns the
 * previous state back by reference whenever nothing needs to change.
 */
export function useScopeDraft(input: {
  conversationId: string | null;
  pinnedProjectId: string | null;
  lastUserSnapshot: ScopeSnapshot | null;
}) {
  const page = usePageContext();
  const projects = api.project.list.useQuery();
  const accessibleProjectIds = useMemo(
    () => (projects.data ? projects.data.map((p) => p.id) : null),
    [projects.data],
  );
  const accessibleProjects = useMemo(
    () => (projects.data ?? []).map((p) => ({ id: p.id, name: p.name })),
    [projects.data],
  );

  const [state, setState] = useState<ScopeDraftState>(() =>
    deriveScopeDraftState(null, input, page, accessibleProjectIds),
  );
  const derived = deriveScopeDraftState(
    state,
    input,
    page,
    accessibleProjectIds,
  );
  if (derived !== state) {
    setState(derived);
  }

  return {
    draft: derived.draft,
    setDraft: (draft: ScopeRequest) =>
      setState((c) => ({ ...c, draft, seeded: true, dropped: 0 })),
    dropped: derived.dropped,
    accessibleProjects,
    page,
  };
}
