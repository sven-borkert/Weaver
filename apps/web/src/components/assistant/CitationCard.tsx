"use client";

import { FileText, GitBranch, Search, Table2 } from "lucide-react";
import Link from "next/link";
import type { CitationView } from "@weaver/core/assistant/events";
import type { CitationCard as Card } from "@weaver/core/services/assistantCitations";
import { DocumentKindIcon } from "~/components/icons/DocumentKindIcon";
import { citationHref } from "~/lib/assistant/citationHref";
import { api } from "~/trpc/react";

const ICONS = {
  document: FileText,
  table: Table2,
  graph: GitBranch,
  search: Search,
} as const;

export function liveToCard(view: CitationView): Card {
  return {
    id: view.id,
    messageId: null,
    kind: view.kind,
    projectId: view.projectId,
    resourceId: view.resourceId,
    commitSha: view.commitSha,
    access: "ok",
    label: view.label,
    excerpt: view.excerpt,
    // Live cards have no anchor yet; the settled list replaces them. This
    // only matters for "document" (no section yet, links to the top) and
    // "table" (ignored by citationHref's table case either way) — a live
    // "search" citation carries no resourceType at all, so OneCard renders
    // it unlinked below rather than trusting a guess here.
    navigationAnchor: view.kind === "table" ? undefined : null,
  };
}

export function dedupeCitations(
  cards: Card[],
): Array<Card & { count: number }> {
  const byKey = new Map<string, Card & { count: number }>();
  for (const card of cards) {
    const key = `${card.kind}:${card.resourceId}`;
    const existing = byKey.get(key);
    if (existing) existing.count += 1;
    else byKey.set(key, { ...card, count: 1 });
  }
  return [...byKey.values()];
}

/**
 * True once the app has fetched the resource's current head and it has moved
 * past the commit the citation was made at. Pulled out of `RevisionNote` so
 * the comparison itself is unit-testable without going through a component
 * render — the node test environment here has no DOM/testing-library.
 */
export function isCitedAtEarlierRevision(
  currentHead: string | undefined,
  citedCommitSha: string | null,
): boolean {
  return Boolean(
    currentHead && citedCommitSha && currentHead !== citedCommitSha,
  );
}

function RevisionNote({ card }: { card: Card }) {
  // Compare only against a resource the app already fetched; never a new query.
  const doc = api.document.get.useQuery(
    { projectId: card.projectId, documentId: card.resourceId },
    { enabled: false },
  );
  const table = api.table.get.useQuery(
    { projectId: card.projectId, tableId: card.resourceId },
    { enabled: false },
  );
  const head =
    card.kind === "table" ? table.data?.baseCommitSha : doc.data?.baseCommitSha;
  if (!isCitedAtEarlierRevision(head, card.commitSha)) return null;
  return (
    <span className="text-text-muted text-[11px]">
      Cited at an earlier revision
    </span>
  );
}

function CardBody({ card }: { card: Card & { count: number } }) {
  const Icon = ICONS[card.kind];
  return (
    <>
      <span className="text-text flex items-center gap-2 text-[12px] font-medium">
        {card.kind === "document" && card.documentKind ? (
          <DocumentKindIcon
            kind={card.documentKind}
            className="size-3.5 shrink-0"
            aria-hidden="true"
          />
        ) : (
          <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="truncate">{card.label}</span>
        {card.count > 1 ? (
          <span className="text-text-muted">×{card.count}</span>
        ) : null}
      </span>
      {card.excerpt ? (
        <span className="text-text-2 line-clamp-2 text-[12px]">
          {card.excerpt}
        </span>
      ) : null}
      <RevisionNote card={card} />
    </>
  );
}

function OneCard({ card }: { card: Card & { count: number } }) {
  if (card.access !== "ok") {
    const Icon = ICONS[card.kind];
    return (
      <li className="border-line bg-subtle text-text-muted flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[12px]">
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        Source no longer available
      </li>
    );
  }
  // A live `search` citation's wire event carries no `resourceType`, so
  // there is no reliable way to tell a document-search hit from a
  // table-search one yet — `citationHref` would have to guess. Render it
  // unlinked (same layout as the linked card, just no `Link`) rather than
  // pointing at a route that might be wrong; the settled `listCitations`
  // card, which does know the real resourceType, replaces it shortly.
  const isUnresolvedLiveSearch =
    card.kind === "search" && card.messageId === null;
  const href = isUnresolvedLiveSearch ? null : citationHref(card);
  if (!href) {
    return (
      <li className="border-line bg-surface-2 flex flex-col gap-0.5 rounded-md border px-2.5 py-1.5">
        <CardBody card={card} />
      </li>
    );
  }
  return (
    <li className="border-line bg-surface-2 rounded-md border">
      <Link
        href={href}
        className="hover:bg-hover flex flex-col gap-0.5 rounded-md px-2.5 py-1.5"
      >
        <CardBody card={card} />
      </Link>
    </li>
  );
}

/**
 * Orders settled cards by the message's own `citationIds` emission order
 * (spec: the model's ordering is preserved there, not by `listCitations`'
 * run/createdAt/id order, whose tiebreaker is an effectively-shuffled UUID).
 * Anything not present in `citationIds` falls back after, in server order.
 */
export function orderByCitationIds(
  cards: Card[],
  citationIds: readonly string[],
): Card[] {
  const rank = new Map(citationIds.map((id, index) => [id, index]));
  return [...cards].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return 0;
  });
}

export function CitationCards({
  conversationId,
  messageId,
  citationIds,
  live,
}: {
  conversationId: string;
  messageId: string;
  citationIds?: string[];
  live?: CitationView[];
}) {
  const settled = api.assistant.listCitations.useQuery(
    { conversationId, messageId: messageId || undefined },
    { enabled: Boolean(messageId) },
  );
  const cards = messageId
    ? orderByCitationIds(
        (settled.data ?? []).filter((c) => c.messageId === messageId),
        citationIds ?? [],
      )
    : (live ?? []).map(liveToCard);
  const shown = dedupeCitations(cards);
  if (shown.length === 0) return null;
  return (
    <ul aria-label="Sources" className="flex flex-col gap-1">
      {shown.map((card) => (
        <OneCard key={`${card.kind}:${card.resourceId}`} card={card} />
      ))}
    </ul>
  );
}
