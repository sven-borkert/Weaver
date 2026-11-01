import { z } from "zod";

export const searchKnowledgeInput = z.object({
  query: z.string().trim().min(2).max(500),
  projectIds: z.array(z.uuid()).max(50).optional(),
  limitPerGroup: z.number().int().min(1).max(20).default(8),
});
