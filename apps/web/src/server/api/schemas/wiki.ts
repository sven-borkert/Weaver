import { z } from "zod";
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
export const resolveWikiSuggestionInput = wikiProjectInput.extend({
  suggestionId: z.uuid(),
});
