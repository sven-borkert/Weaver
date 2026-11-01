import { z } from "zod";
import { ADMIN_LIST_MAX } from "@weaver/core/services/adminPaging";
import { DIAGNOSTIC_LIST_MAX } from "@weaver/core/services/diagnosticEvents";

export { diagnosticsSettingsPatchSchema as setDiagnosticsSettingsInput } from "@weaver/core/diagnostics/settings";
export { retentionSettingsPatchSchema as setRetentionSettingsInput } from "@weaver/core/diagnostics/retentionSettings";

export const DIAGNOSTIC_SEVERITIES = [
  "debug",
  "info",
  "warn",
  "error",
] as const;
const reference = z.string().regex(/^[0-9a-fA-F]{8}$/);

export const listDiagnosticEventsInput = z.object({
  since: z.date().optional(),
  until: z.date().optional(),
  category: z.string().max(40).optional(),
  event: z.string().max(80).optional(),
  severity: z.enum(DIAGNOSTIC_SEVERITIES).optional(),
  excludeDebug: z.boolean().optional(),
  reference: reference.optional(),
  requestId: z.string().max(64).optional(),
  jobId: z.string().max(64).optional(),
  runId: z.uuid().optional(),
  userId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  generationId: z.uuid().optional(),
  documentId: z.uuid().optional(),
  fileId: z.uuid().optional(),
  connectionId: z.uuid().optional(),
  text: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(DIAGNOSTIC_LIST_MAX).optional(),
  cursor: z.string().max(400).optional(),
});
export type ListDiagnosticEventsInput = z.infer<
  typeof listDiagnosticEventsInput
>;

export const getDiagnosticEventInput = z.object({
  id: z.uuid().optional(),
  reference: reference.optional(),
  body: z.enum(["none", "request", "response"]).optional(),
  offset: z.number().int().min(0).optional(),
});

export const listChangeSummariesInput = z.object({
  status: z.enum(["pending", "ready", "failed", "skipped"]).optional(),
  projectId: z.uuid().optional(),
  documentId: z.uuid().optional(),
  since: z.date().optional(),
  limit: z.number().int().min(1).max(ADMIN_LIST_MAX).optional(),
  cursor: z.string().max(600).optional(),
});

export {
  listProcessingInput,
  listProcessingQueueInput,
} from "@weaver/core/diagnostics/processingSchema";
