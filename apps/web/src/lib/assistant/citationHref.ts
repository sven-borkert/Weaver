import type { CitationCard } from "@weaver/core/services/assistantCitations";
import { documentSectionHref } from "~/lib/documents/section-navigation";
import { graphHref } from "~/lib/knowledge/graphUrl";

function documentHref(card: CitationCard, documentId: string): string {
  const section = card.navigationAnchor;
  const sha = card.commitSha;
  return documentSectionHref({
    projectId: card.projectId,
    documentId,
    navigation:
      section && sha && /^[a-f0-9]{40}$/.test(sha)
        ? { section, sourceCommitSha: sha }
        : undefined,
  });
}

/** Where a citation card links, or null when the source is unavailable. */
export function citationHref(card: CitationCard): string | null {
  if (card.access !== "ok") return null;
  const p = encodeURIComponent(card.projectId);
  switch (card.kind) {
    case "document":
      return documentHref(card, card.resourceId);
    case "search":
      // Task 2's listCitations sets navigationAnchor: null for a document-search
      // hit and leaves it undefined (never set) for a table-search hit — the
      // only way to tell the two apart, since neither carries a resource type.
      return card.navigationAnchor === undefined
        ? `/projects/${p}/tables/${encodeURIComponent(card.resourceId)}`
        : documentHref(card, card.resourceId);
    case "table":
      return `/projects/${p}/tables/${encodeURIComponent(card.resourceId)}`;
    case "graph":
      if (card.entityId)
        return graphHref(card.projectId, {
          focusId: card.entityId,
          projectIds: [card.projectId],
          entityTypes: [],
          relationTypes: [],
        });
      return card.documentId
        ? `/projects/${p}/documents/${encodeURIComponent(card.documentId)}`
        : `/projects/${p}/graph`;
  }
}
