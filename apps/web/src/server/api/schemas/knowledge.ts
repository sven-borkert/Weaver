import { z } from "zod";

export const knowledgeProjectInput = z.object({
  projectId: z.uuid(),
});

export const knowledgeDocumentInput = knowledgeProjectInput.extend({
  documentId: z.uuid(),
});

export const knowledgeRetryInput = knowledgeProjectInput.extend({
  cursor: z
    .object({
      generationId: z.uuid(),
      documentId: z.uuid(),
    })
    .optional(),
});
