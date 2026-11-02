import type { PrismaClient } from "@weaver/db/client";
import type { DocumentKind } from "../documents/kinds";
import {
  createSourceValidationCache,
  sourceLocatorSchema,
  validateSourceLocators,
} from "../assistant/citations";
import type { UserSecurityContext } from "../security/context";
import { requireOwnedConversation } from "./assistantConversations";
import { resolveProjectAccess } from "./projectAccess";

export type CitationCard = {
  id: string;
  messageId: string | null;
  kind: "document" | "table" | "graph" | "search";
  projectId: string;
  resourceId: string;
  commitSha: string | null;
  access: "ok" | "unavailable";
  label?: string;
  excerpt?: string | null;
  headingPath?: string[];
  navigationAnchor?: string | null;
  rowIds?: string[];
  columnIds?: string[];
  entityId?: string | null;
  documentId?: string | null;
  documentKind?: DocumentKind;
};

export async function listCitations(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: { conversationId: string; messageId?: string },
): Promise<CitationCard[]> {
  await requireOwnedConversation(db, actor, input.conversationId);
  const rows = await db.assistantCitation.findMany({
    where: {
      run: { conversationId: input.conversationId },
      ...(input.messageId ? { messageId: input.messageId } : {}),
    },
    // IDs keep same-timestamp citations in a stable order.
    orderBy: [
      { run: { queuedAt: "asc" } },
      { createdAt: "asc" },
      { id: "asc" },
    ],
    select: {
      id: true,
      messageId: true,
      kind: true,
      projectId: true,
      resourceId: true,
      commitSha: true,
      label: true,
      excerpt: true,
      locator: true,
    },
  });
  const accessible = new Map<string, boolean>();
  const sourceCache = createSourceValidationCache();
  const cards: CitationCard[] = [];
  for (const row of rows) {
    const base = {
      id: row.id,
      messageId: row.messageId,
      kind: row.kind,
      projectId: row.projectId,
      resourceId: row.resourceId,
      commitSha: row.commitSha,
    };
    let ok = accessible.get(row.projectId);
    if (ok === undefined) {
      try {
        await resolveProjectAccess(db, row.projectId, actor);
        ok = true;
      } catch {
        ok = false;
      }
      accessible.set(row.projectId, ok);
    }
    if (!ok) {
      // Spec §14: an inaccessible source leaks neither its label nor its excerpt.
      cards.push({ ...base, access: "unavailable" });
      continue;
    }
    const parsed = sourceLocatorSchema.safeParse(row.locator);
    const [verified] =
      parsed.success && parsed.data.projectId === row.projectId
        ? await validateSourceLocators(db, actor, [parsed.data], sourceCache)
        : [];
    if (
      verified?.kind !== row.kind ||
      verified.resourceId !== row.resourceId ||
      (row.commitSha !== null && verified.commitSha !== row.commitSha)
    ) {
      cards.push({ ...base, access: "unavailable" });
      continue;
    }
    const card: CitationCard = {
      ...base,
      commitSha: verified.commitSha,
      access: "ok",
      label: verified.label,
      excerpt: verified.excerpt,
    };
    const locator = verified.locator;
    switch (locator.kind) {
      case "document":
        card.headingPath = locator.headingPath;
        card.navigationAnchor = verified.navigationAnchor ?? null;
        break;
      case "table":
        card.rowIds = locator.rowIds;
        card.columnIds = locator.columnIds;
        break;
      case "graph":
        card.entityId = locator.entityId ?? null;
        card.documentId = locator.documentId;
        break;
      case "search":
        if (locator.resourceType === "document") card.navigationAnchor = null;
        break;
    }
    cards.push(card);
  }
  const documentCards = cards.filter(
    (card) => card.kind === "document" && card.access === "ok",
  );
  if (documentCards.length > 0) {
    const kinds = new Map(
      (
        await db.document.findMany({
          where: { id: { in: documentCards.map((card) => card.resourceId) } },
          select: { id: true, projectId: true, kind: true },
        })
      ).map((doc) => [`${doc.projectId}:${doc.id}`, doc.kind]),
    );
    for (const card of documentCards)
      card.documentKind = kinds.get(`${card.projectId}:${card.resourceId}`);
  }
  return cards;
}
