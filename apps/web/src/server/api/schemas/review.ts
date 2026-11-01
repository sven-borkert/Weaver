import { z } from "zod";
import {
  MAX_REVIEWERS,
  REVIEW_MONTHS_MAX,
  REVIEW_MONTHS_MIN,
} from "@weaver/core/documents/review";

const id = z.uuid();
export const reviewerTarget = z.object({ type: z.enum(["user", "group"]), id });
export const everyMonths = z
  .number()
  .int()
  .min(REVIEW_MONTHS_MIN)
  .max(REVIEW_MONTHS_MAX);
export const projectInput = z.object({ projectId: id });
export const groupName = z
  .string()
  .trim()
  .min(1)
  .refine((name) => [...name].length <= 80, "At most 80 characters");
export const createGroupInput = z.object({
  projectId: id,
  name: groupName,
  memberIds: z.array(id).max(200),
});
export const renameGroupInput = z.object({
  projectId: id,
  groupId: id,
  name: groupName,
});
export const setGroupMembersInput = z.object({
  projectId: id,
  groupId: id,
  memberIds: z.array(id).max(200),
});
export const groupInput = z.object({ projectId: id, groupId: id });
export const setDefaultsInput = z.object({
  projectId: id,
  everyMonths,
  reviewers: z.array(reviewerTarget).max(MAX_REVIEWERS),
});
export const listDueInput = z.object({
  cursor: z.string().max(400).optional(),
});
export const listRecentInput = listDueInput;
export const markReviewedInput = z.object({
  projectId: id,
  documentId: id,
  expectedHeadCommitSha: z.string().regex(/^[0-9a-f]{40}$/),
});
export const setReviewInput = markReviewedInput.extend({
  reviewers: z.array(reviewerTarget).max(MAX_REVIEWERS).optional(),
  everyMonths: everyMonths.optional(),
});
