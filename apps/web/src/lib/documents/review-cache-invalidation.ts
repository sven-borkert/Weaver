import type { api } from "~/trpc/react";

export const RELOAD_BEFORE_EDITING_HINT =
  "The review was saved, but the document could not be refreshed. Reload the page before editing.";

/** Resolves once the page's document.get has been refetched (rejects if that fails); the editor session adopts the new head from it. */
export async function invalidateDocumentReview(
  utils: ReturnType<typeof api.useUtils>,
  projectId: string,
  documentId: string,
): Promise<void> {
  const input = { projectId, documentId };
  void utils.document.reviewPermissions.invalidate(input);
  void utils.document.history.invalidate(input);
  void utils.review.dueCount.invalidate();
  void utils.review.listDue.invalidate();
  void utils.review.listRecent.invalidate();
  await utils.document.get.invalidate(input, { refetchType: "none" });
  await utils.document.get.fetch(input);
}

/** Refetch canonical reads; editor sessions retain their own dirty baseline and revision guard. */
export async function invalidateFolderReview(
  utils: ReturnType<typeof api.useUtils>,
  projectId: string,
): Promise<void> {
  const input = { projectId };
  const options = { throwOnError: true };
  await Promise.all([
    utils.folder.tree.invalidate(input, undefined, options),
    utils.folder.reviewDefaults.invalidate(input, undefined, options),
    utils.folder.previewReview.invalidate(input, undefined, options),
    utils.folder.previewMarkReviewed.invalidate(input, undefined, options),
    utils.document.list.invalidate(input, undefined, options),
    utils.document.get.invalidate(input, undefined, options),
    utils.document.history.invalidate(input, undefined, options),
    utils.document.reviewPermissions.invalidate(input, undefined, options),
    utils.review.dueCount.invalidate(undefined, undefined, options),
    utils.review.listDue.invalidate(undefined, undefined, options),
    utils.review.listRecent.invalidate(undefined, undefined, options),
  ]);
}
