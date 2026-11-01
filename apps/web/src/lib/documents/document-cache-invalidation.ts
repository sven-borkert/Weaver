type ProjectInput = { projectId: string };
type Invalidation = (input?: ProjectInput) => Promise<unknown>;

type RebuildCacheUtils = {
  document: {
    list: { invalidate: (input: ProjectInput) => Promise<unknown> };
    get: { invalidate: Invalidation };
    history: { invalidate: Invalidation };
    backlinks: { invalidate: Invalidation };
    resolveRefs: { invalidate: Invalidation };
  };
  folder: {
    tree: { invalidate: (input: ProjectInput) => Promise<unknown> };
  };
  table: {
    list: { invalidate: (input: ProjectInput) => Promise<unknown> };
    get: { invalidate: Invalidation };
    backlinks: { invalidate: Invalidation };
  };
};

type DocumentReferenceCacheUtils = Pick<
  RebuildCacheUtils,
  "document" | "table"
>;

export async function invalidateDocumentReferenceCaches(
  utils: DocumentReferenceCacheUtils,
  projectId: string,
): Promise<void> {
  await Promise.all([
    utils.table.backlinks.invalidate({ projectId }),
    utils.table.get.invalidate({ projectId }),
    utils.table.list.invalidate({ projectId }),
    utils.document.resolveRefs.invalidate({ projectId }),
  ]);
}

export async function invalidateDocumentCachesAfterRebuild(
  utils: RebuildCacheUtils,
  projectId: string,
): Promise<void> {
  await Promise.all([
    utils.document.list.invalidate({ projectId }),
    utils.folder.tree.invalidate({ projectId }),
    utils.document.get.invalidate({ projectId }),
    utils.document.history.invalidate({ projectId }),
    utils.document.backlinks.invalidate({ projectId }),
    invalidateDocumentReferenceCaches(utils, projectId),
  ]);
}
