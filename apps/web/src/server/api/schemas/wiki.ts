import { z } from "zod";
import {
  WIKI_NOTE_MAX_CHARS,
  WIKI_QUEUE_MAX_ITEMS,
} from "@weaver/core/wiki/states";
import {
  WIKI_BUDGET_MAX,
  WIKI_BUDGET_MIN,
  WIKI_SPEND_ALERT_MAX_CENTS,
} from "@weaver/core/services/wikiSettings";

export const wikiProjectInput = z.object({ projectId: z.uuid() });
export const wikiRevisionInput = wikiProjectInput.extend({
  expectedRevision: z.number().int().min(0),
});
export const updateWikiSettingsInput = wikiRevisionInput.extend({
  destructiveBudget24h: z
    .number()
    .int()
    .min(WIKI_BUDGET_MIN)
    .max(WIKI_BUDGET_MAX)
    .optional(),
  spendAlertCentsPerDay: z
    .number()
    .int()
    .min(1)
    .max(WIKI_SPEND_ALERT_MAX_CENTS)
    .nullable()
    .optional(),
});
export const setWikiGuideDocumentInput = wikiRevisionInput.extend({
  documentId: z.uuid(),
});
export const approveWikiGuideInput = wikiRevisionInput.extend({
  expectedDigest: z.string().regex(/^[0-9a-f]{64}$/),
});
const inputItem = wikiProjectInput.extend({ itemId: z.uuid() });
export const addWikiTextInput = wikiProjectInput.extend({
  title: z.string().max(500).optional(),
  // The service counts characters and answers with its own field error.
  text: z.string().max(WIKI_NOTE_MAX_CHARS + 1),
});
export const addWikiFilesInput = wikiProjectInput.extend({
  artifactIds: z.array(z.uuid()).min(1).max(WIKI_QUEUE_MAX_ITEMS),
});
export const processWikiInputs = wikiProjectInput.extend({
  itemIds: z.union([
    z.literal("all"),
    z.array(z.uuid()).min(1).max(WIKI_QUEUE_MAX_ITEMS),
  ]),
});
export const wikiInputItemInput = inputItem;
export const confirmWikiInput = inputItem.extend({
  expectedDigest: z.string().regex(/^[0-9a-f]{64}$/),
});
export const cancelWikiRunInput = wikiProjectInput.extend({
  runId: z.uuid(),
});
export const listWikiRunsInput = wikiProjectInput.extend({
  cursor: z.uuid().optional(),
});
export const resolveWikiSuggestionInput = wikiProjectInput.extend({
  suggestionId: z.uuid(),
});
