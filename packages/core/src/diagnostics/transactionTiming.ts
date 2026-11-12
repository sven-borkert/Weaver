import { emitDiagnostic } from "./writer";

export async function observeContentTransaction<T>(
  operation: "project.create" | "project.key-policy",
  projectId: string,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    return await run();
  } finally {
    const durationMs = Date.now() - started;
    if (durationMs >= 5000)
      emitDiagnostic({
        event: "database.transaction.slow",
        severity: "warn",
        message: "Content transaction exceeded five seconds",
        projectId,
        durationMs,
        details: { operation },
      });
  }
}
