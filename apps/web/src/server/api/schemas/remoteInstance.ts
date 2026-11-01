import { z } from "zod";
import { folderPathSchema } from "./folder";

export const remoteInstanceIdInput = z.object({ id: z.uuid() });
export const remoteInstanceRefInput = z.object({ remoteInstanceId: z.uuid() });
export const createRemoteInstanceInput = z.object({
  name: z.string().min(1).max(120),
  baseUrl: z.string().min(1).max(2048),
  enabled: z.boolean().optional(),
});
export const updateRemoteInstanceInput = z.object({
  id: z.uuid(),
  expectedRevision: z.number().int().positive(),
  patch: createRemoteInstanceInput.partial(),
});
export const revisionRemoteInstanceInput = z.object({
  id: z.uuid(),
  expectedRevision: z.number().int().positive(),
});
export const remoteTargetFoldersInput = z.object({
  remoteInstanceId: z.uuid(),
  projectId: z.uuid(),
});
export const sendDocumentInput = z.object({
  remoteInstanceId: z.uuid(),
  projectId: z.uuid(),
  documentId: z.uuid(),
  targetProjectId: z.uuid(),
  targetFolderPath: folderPathSchema,
});
export const sendTableInput = z.object({
  remoteInstanceId: z.uuid(),
  projectId: z.uuid(),
  tableId: z.uuid(),
  targetProjectId: z.uuid(),
  targetFolderPath: folderPathSchema,
});
