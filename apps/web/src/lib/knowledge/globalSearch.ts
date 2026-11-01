import {
  documentKindOfPath,
  type DocumentKind,
} from "@weaver/core/documents/kinds";
import { documentSectionHref } from "~/lib/documents/section-navigation";
import { graphHref } from "~/lib/knowledge/graphUrl";

export type GlobalSearchResultLike = {
  documents: Array<{
    documentId: string;
    projectId: string;
    projectName: string;
    sourceCommitSha: string;
    title: string;
    path: string;
    headingPath: string[];
    navigationAnchor: string | null;
    snippet: string;
  }>;
  tables: Array<{
    tableId: string;
    projectId: string;
    projectName: string;
    title: string;
    rowCount: number;
    matchingColumns: string[];
  }>;
  entities: Array<{
    entityId: string;
    projectId: string;
    projectName: string;
    canonicalName: string;
    entityType: string;
    description: string | null;
    aliases: string[];
  }>;
};

export type GlobalSearchOption =
  | {
      kind: "document";
      key: `document:${string}`;
      group: "Documents";
      documentKind: DocumentKind;
      href: string;
      title: string;
      projectName: string;
      headingPath: string[];
      snippet: string;
    }
  | {
      kind: "table";
      key: `table:${string}`;
      group: "Tables";
      href: string;
      title: string;
      projectName: string;
      rowCount: number;
      matchingColumns: string[];
    }
  | {
      kind: "entity";
      key: `entity:${string}`;
      group: "Entities";
      href: string;
      title: string;
      projectName: string;
      entityType: string;
      description: string | null;
      aliases: string[];
    };

export type GlobalSearchMove = "next" | "previous" | "first" | "last";

export function normalizeGlobalSearchProjectIds(
  ids: readonly string[],
): string[] | undefined {
  const normalized = [...new Set(ids)].sort().slice(0, 50);
  return normalized.length > 0 ? normalized : undefined;
}

export function globalSearchResponseIdentity(
  query: string,
  projectIds: readonly string[] | undefined,
): string {
  return JSON.stringify({
    query: query.trim(),
    projectIds: normalizeGlobalSearchProjectIds(projectIds ?? []),
  });
}

export function flattenGlobalSearchOptions(
  result: GlobalSearchResultLike,
): GlobalSearchOption[] {
  return [
    ...result.documents.map((document) => ({
      kind: "document" as const,
      key: `document:${document.documentId}` as const,
      group: "Documents" as const,
      documentKind: documentKindOfPath(document.path),
      href: documentSectionHref({
        projectId: document.projectId,
        documentId: document.documentId,
        navigation: document.navigationAnchor
          ? {
              section: document.navigationAnchor,
              sourceCommitSha: document.sourceCommitSha,
            }
          : undefined,
      }),
      title: document.title,
      projectName: document.projectName,
      headingPath: document.headingPath,
      snippet: document.snippet,
    })),
    ...result.tables.map((table) => ({
      kind: "table" as const,
      key: `table:${table.tableId}` as const,
      group: "Tables" as const,
      href: `/projects/${encodeURIComponent(table.projectId)}/tables/${encodeURIComponent(table.tableId)}`,
      title: table.title,
      projectName: table.projectName,
      rowCount: table.rowCount,
      matchingColumns: table.matchingColumns,
    })),
    ...result.entities.map((entity) => ({
      kind: "entity" as const,
      key: `entity:${entity.entityId}` as const,
      group: "Entities" as const,
      href: graphHref(entity.projectId, {
        focusId: entity.entityId,
        projectIds: [entity.projectId],
        entityTypes: [],
        relationTypes: [],
      }),
      title: entity.canonicalName,
      projectName: entity.projectName,
      entityType: entity.entityType,
      description: entity.description,
      aliases: entity.aliases,
    })),
  ];
}

export function moveGlobalSearchActive(
  options: readonly GlobalSearchOption[],
  activeKey: string | undefined,
  move: GlobalSearchMove,
): string | undefined {
  if (options.length === 0) return undefined;
  if (move === "first") return options[0]?.key;
  if (move === "last") return options.at(-1)?.key;

  const activeIndex = options.findIndex((option) => option.key === activeKey);
  if (activeIndex === -1) {
    return move === "next" ? options[0]?.key : options.at(-1)?.key;
  }

  if (move === "next") {
    return options[(activeIndex + 1) % options.length]?.key;
  }

  return options[(activeIndex - 1 + options.length) % options.length]?.key;
}
