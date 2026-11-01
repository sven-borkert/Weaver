import { z } from "zod";

export const projectRoleEnum = z.enum([
  "Owner",
  "Maintainer",
  "Editor",
  "Viewer",
]);

export const listMembersInput = z.object({ projectId: z.uuid() });

export const addMemberInput = z.object({
  projectId: z.uuid(),
  // Better Auth stores emails lowercased; normalise so lookups match.
  email: z.string().trim().toLowerCase().pipe(z.email()),
  role: projectRoleEnum,
});

export const updateMemberRoleInput = z.object({
  projectId: z.uuid(),
  userId: z.uuid(),
  role: projectRoleEnum,
});

export const removeMemberInput = z.object({
  projectId: z.uuid(),
  userId: z.uuid(),
});

export const setTrainingRoleInput = z.object({
  projectId: z.uuid(),
  userId: z.uuid(),
  role: z.enum(["trainer", "trainee"]).nullable(),
});
