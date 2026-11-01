import type { PrismaClient } from "@weaver/db/client";
import { emitDiagnostic } from "../diagnostics/writer";
import { recordAiUsage, type RecordAiUsageInput } from "./aiUsage";

export async function recordAiUsageSafely(
  db: PrismaClient,
  input: RecordAiUsageInput,
  record: (
    db: PrismaClient,
    input: RecordAiUsageInput,
  ) => Promise<unknown> = recordAiUsage,
): Promise<boolean> {
  try {
    await record(db, input);
    return true;
  } catch {
    emitDiagnostic({
      event: "ai.usage.failed",
      severity: "warn",
      message: "AI usage could not be recorded",
      outcome: "error",
      projectId: input.projectId ?? undefined,
      documentId: input.documentId ?? undefined,
      jobId: input.jobId ?? undefined,
      runId: input.runId ?? undefined,
      connectionId: input.connectionId ?? undefined,
      details: {
        operation: input.operation,
        usageOutcome: input.outcome,
        failureKind: "accounting",
      },
    });
    return false;
  }
}
