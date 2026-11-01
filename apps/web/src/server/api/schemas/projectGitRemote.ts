import { z } from "zod";

export const projectGitRemoteInput = z.object({ projectId: z.uuid() });
export const projectGitRemoteRevisionInput = projectGitRemoteInput.extend({
  expectedRevision: z.number().int().positive(),
});
export const saveProjectGitRemoteInput = projectGitRemoteInput.extend({
  expectedRevision: z.number().int().positive().optional(),
  remoteUrl: z.string().trim().min(1).max(2048),
  branch: z.string().trim().min(1).max(255),
  enabled: z.boolean(),
});
export const uploadProjectGitRemoteKeyInput =
  projectGitRemoteRevisionInput.extend({
    keyName: z.string().trim().min(1).max(120),
    privateKey: z.string().min(1).max(65536),
  });
