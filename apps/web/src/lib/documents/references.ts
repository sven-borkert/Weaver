import type { JSONContent } from "@tiptap/core";

export type CollectedDocumentReference = {
  targetType: "document" | "table";
  targetId: string;
  label: string | null;
};

export function documentReferenceKey(
  targetType: "document" | "table",
  targetId: string,
): string {
  return `${targetType}:${targetId}`;
}

export function indexResolvedDocumentReferences<
  T extends {
    id: string;
    exists: boolean;
    targetType?: unknown;
  },
>(targets: T[]): Map<string, T> {
  const resolved = new Map<string, T>();

  for (const target of targets) {
    if (
      target.exists &&
      (target.targetType === "document" || target.targetType === "table")
    ) {
      resolved.set(documentReferenceKey(target.targetType, target.id), target);
    }
  }

  return resolved;
}

export function collectDocumentReferences(
  content: JSONContent,
): CollectedDocumentReference[] {
  const references: CollectedDocumentReference[] = [];
  const seen = new Set<string>();

  const visit = (node: JSONContent) => {
    const targetId: unknown = node.attrs?.targetId;
    const targetType =
      node.attrs?.targetType === "table" ? ("table" as const) : "document";
    const targetKey =
      typeof targetId === "string"
        ? documentReferenceKey(targetType, targetId)
        : null;
    if (
      node.type === "crossref" &&
      typeof targetId === "string" &&
      targetKey !== null &&
      !seen.has(targetKey)
    ) {
      seen.add(targetKey);
      references.push({
        targetType,
        targetId,
        label: typeof node.attrs?.label === "string" ? node.attrs.label : null,
      });
    }

    node.content?.forEach(visit);
  };

  visit(content);
  return references;
}
