import { MAX_REVIEWERS } from "@weaver/core/documents/review";
import { reviewerTarget } from "./review";
import { z } from "zod";
import { MAX_FOLDER_DEPTH, SEGMENT_RE } from "@weaver/core/documents/paths";

const segment = z.string().regex(SEGMENT_RE);
export const folderPathSchema = z.array(segment).max(MAX_FOLDER_DEPTH);
const folderName = z.string().trim().min(1).max(120);

export const folderTreeInput = z.object({ projectId: z.uuid() });
export const createFolderInput = z.object({
  projectId: z.uuid(),
  parentPath: folderPathSchema,
  name: folderName,
});
export const renameFolderInput = z.object({
  projectId: z.uuid(),
  path: folderPathSchema.min(1),
  name: folderName,
});
export const moveFolderInput = z.object({
  projectId: z.uuid(),
  path: folderPathSchema.min(1),
  newParentPath: folderPathSchema,
});
export const deleteFolderInput = z.object({
  projectId: z.uuid(),
  path: folderPathSchema.min(1),
});

export const folderReviewTargetInput = z.object({
  projectId: z.uuid(),
  path: folderPathSchema,
});
export const folderReviewInput = folderReviewTargetInput.extend({
  reviewers: z.array(reviewerTarget).max(MAX_REVIEWERS),
});
export const setFolderReviewInput = folderReviewInput.extend({
  expectedHeadCommitSha: z.string().regex(/^[0-9a-f]{40}$/),
});
export const clearFolderReviewInput = folderReviewTargetInput.extend({
  expectedHeadCommitSha: z.string().regex(/^[0-9a-f]{40}$/),
});
