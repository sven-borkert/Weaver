/**
 * assistantEvents/assistantAttempts are the only entries the pruner still reads
 * from here; aiUsage/taskRuns are admin-configurable defaults now sourced from
 * `diagnostics/retentionSettings.ts` (SystemSetting-backed). Both display
 * defaults are kept here for `ProcessingCard.tsx`'s static description text.
 */
export const PROCESSING_RETENTION_DAYS = {
  aiUsage: 90,
  taskRuns: 30,
  assistantEvents: 7,
  assistantAttempts: 30,
} as const;
