import { AsyncLocalStorage } from "node:async_hooks";
import { parseContextProjectIds } from "../externalMcp/historyScope";
import { processSingleton } from "./processState";

export type DiagnosticContext = {
  suppressProviderBodies?: boolean;
  bodyProjectIds?: readonly string[] | null;
  requestId?: string;
  jobId?: string;
  runId?: string;
  userId?: string;
  credentialId?: string;
  projectId?: string;
  generationId?: string;
  documentId?: string;
  connectionId?: string;
};

const storage = processSingleton(
  "context",
  () => new AsyncLocalStorage<DiagnosticContext>(),
);

export function mergeDiagnosticContexts(
  parent: DiagnosticContext,
  context: DiagnosticContext,
): DiagnosticContext {
  const defined = Object.fromEntries(
    Object.entries(context).filter(
      ([, value]) => value !== undefined && value !== null,
    ),
  );
  const sources = [parent.bodyProjectIds, context.bodyProjectIds].filter(
    (ids) => ids !== undefined,
  );
  const parsed = sources.map(parseContextProjectIds);
  const bodyProjectIds = parsed.some((ids) => ids === null)
    ? null
    : parseContextProjectIds([...new Set(parsed.flat())]);
  return {
    ...parent,
    ...defined,
    ...(sources.length > 0
      ? {
          bodyProjectIds:
            bodyProjectIds === null ? null : Object.freeze(bodyProjectIds),
        }
      : {}),
    ...(parent.suppressProviderBodies === true ||
    context.suppressProviderBodies === true
      ? { suppressProviderBodies: true }
      : {}),
  };
}

export function providerBodiesSuppressed(context: DiagnosticContext): boolean {
  return (
    context.suppressProviderBodies === true ||
    context.bodyProjectIds === null ||
    (context.runId !== undefined && context.bodyProjectIds === undefined)
  );
}

export function withDiagnosticContext<T>(
  context: DiagnosticContext,
  fn: () => T,
): T {
  return storage.run(
    mergeDiagnosticContexts(currentDiagnosticContext(), context),
    fn,
  );
}

export function currentDiagnosticContext(): DiagnosticContext {
  return storage.getStore() ?? {};
}

/** Captures the exact current diagnostic context for callbacks invoked by another async caller. */
export function bindDiagnosticContext<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const captured = mergeDiagnosticContexts({}, currentDiagnosticContext());
  return (...args) =>
    storage.run(
      mergeDiagnosticContexts(captured, {
        bodyProjectIds: currentDiagnosticContext().bodyProjectIds,
        suppressProviderBodies:
          currentDiagnosticContext().suppressProviderBodies,
      }),
      () => fn(...args),
    );
}
