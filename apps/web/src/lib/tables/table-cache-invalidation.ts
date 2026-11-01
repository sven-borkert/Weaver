type ProjectInput = { projectId: string };
type TableInput = ProjectInput & { tableId: string };
type Invalidation<T> = (input?: T) => Promise<unknown>;

export type TableCacheUtils = {
  table: {
    list: { invalidate: (input: ProjectInput) => Promise<unknown> };
    get: { invalidate: Invalidation<TableInput> };
    history: { invalidate: Invalidation<TableInput> };
    diff: { invalidate: Invalidation<TableInput> };
    backlinks: { invalidate: Invalidation<TableInput> };
  };
  tableFolder: {
    tree: { invalidate: (input: ProjectInput) => Promise<unknown> };
  };
  document: {
    resolveRefs: { invalidate: Invalidation<ProjectInput> };
  };
};

export async function invalidateTableCaches(
  utils: TableCacheUtils,
  projectId: string,
  tableId?: string,
): Promise<void> {
  const tableInput = tableId ? { projectId, tableId } : undefined;

  await Promise.all([
    utils.table.list.invalidate({ projectId }),
    utils.tableFolder.tree.invalidate({ projectId }),
    utils.table.get.invalidate(tableInput),
    utils.table.history.invalidate(tableInput),
    utils.table.diff.invalidate(),
    utils.table.backlinks.invalidate(tableInput),
    utils.document.resolveRefs.invalidate(),
  ]);
}
