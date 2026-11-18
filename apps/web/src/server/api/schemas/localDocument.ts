import { z } from "zod";
import { projectIdInput } from "./project";

export const localDocumentIdInput = projectIdInput.extend({
  entryId: z.uuid(),
});

export const createLocalDocumentInput = projectIdInput.extend({
  parentId: z.uuid().nullish(),
  kind: z.enum(["document", "folder"]),
  title: z.string(),
});

export const deleteLocalDocumentInput = localDocumentIdInput.extend({
  revision: z.int32().positive(),
});

export const updateLocalDocumentInput = deleteLocalDocumentInput.extend({
  title: z.string().optional(),
  markdown: z.string().optional(),
});
