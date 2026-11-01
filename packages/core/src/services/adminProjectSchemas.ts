import { z } from "zod";

export const listAdminProjectsInput = z.object({
  search: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().max(2048).optional(),
});

export const adminProjectIdInput = z.object({ projectId: z.uuid() });
