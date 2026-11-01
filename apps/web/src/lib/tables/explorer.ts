import type { Appearance } from "@weaver/core/appearance/metadata";
export type TableItem = {
  id: string;
  title: string;
  path: string;
  appearance?: Appearance | null;
  lastEditedAt: Date;
  lastEditedBy: { id: string | null; name: string; email: string } | null;
  rowCount: number;
};

export function tablesBase(projectId: string): string {
  return `/projects/${projectId}/tables`;
}
export function tableHref(projectId: string, tableId: string): string {
  return `${tablesBase(projectId)}/${tableId}`;
}
/** Strips the reserved "tables/" root so folderPath matches the tables folder namespace. */
export function tableItemFromLeaf(leaf: TableItem): TableItem {
  return { ...leaf, path: leaf.path.replace(/^tables\//, "") };
}
