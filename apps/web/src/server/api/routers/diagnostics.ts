import {
  listProcessing,
  listProcessingQueue,
  processingQueueSummary,
} from "@weaver/core/services/processingInspection";
import {
  getDiagnosticEvent,
  listDiagnosticEvents,
  pruneDiagnosticEventsAsAdmin,
} from "@weaver/core/services/diagnosticEvents";
import {
  diagnosticsStats,
  getDiagnosticsSettingsAsAdmin,
  setDiagnosticsSettings,
} from "@weaver/core/services/diagnosticsSettings";
import { listDocumentChangeSummaries } from "@weaver/core/services/documentChangeSummaryInspection";
import {
  getRetentionSettings,
  setRetentionSettings,
} from "@weaver/core/services/retentionSettings";

import {
  listProcessingInput,
  listProcessingQueueInput,
  getDiagnosticEventInput,
  listChangeSummariesInput,
  listDiagnosticEventsInput,
  setDiagnosticsSettingsInput,
  setRetentionSettingsInput,
} from "~/server/api/schemas/diagnostics";
import { adminProcedure, createTRPCRouter } from "~/server/api/trpc";

export const diagnosticsRouter = createTRPCRouter({
  listProcessing: adminProcedure
    .input(listProcessingInput)
    .query(({ ctx, input }) => listProcessing(ctx.db, ctx.security, input)),
  listProcessingQueue: adminProcedure
    .input(listProcessingQueueInput)
    .query(({ ctx, input }) =>
      listProcessingQueue(ctx.db, ctx.security, input),
    ),
  processingQueueSummary: adminProcedure.query(({ ctx }) =>
    processingQueueSummary(ctx.db, ctx.security),
  ),
  getSettings: adminProcedure.query(async ({ ctx }) => ({
    settings: await getDiagnosticsSettingsAsAdmin(ctx.db, ctx.security),
    stats: await diagnosticsStats(ctx.db, ctx.security),
  })),
  setSettings: adminProcedure
    .input(setDiagnosticsSettingsInput)
    .mutation(async ({ ctx, input }) => ({
      settings: await setDiagnosticsSettings(ctx.db, ctx.security, input),
    })),
  listEvents: adminProcedure
    .input(listDiagnosticEventsInput)
    .query(({ ctx, input }) =>
      listDiagnosticEvents(ctx.db, ctx.security, input),
    ),
  getEvent: adminProcedure
    .input(getDiagnosticEventInput)
    .query(({ ctx, input }) => getDiagnosticEvent(ctx.db, ctx.security, input)),
  prune: adminProcedure.mutation(({ ctx }) =>
    pruneDiagnosticEventsAsAdmin(ctx.db, ctx.security),
  ),
  listChangeSummaries: adminProcedure
    .input(listChangeSummariesInput)
    .query(({ ctx, input }) =>
      listDocumentChangeSummaries(ctx.db, ctx.security, input),
    ),
  getRetentionSettings: adminProcedure.query(async ({ ctx }) => ({
    settings: await getRetentionSettings(ctx.db),
  })),
  setRetentionSettings: adminProcedure
    .input(setRetentionSettingsInput)
    .mutation(async ({ ctx, input }) => ({
      settings: await setRetentionSettings(ctx.db, ctx.security, input),
    })),
});
