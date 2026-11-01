import type { ListDiagnosticEventsInput } from "~/server/api/schemas/diagnostics";

export type EventFilters = {
  severity: "info-and-above" | "all" | "debug" | "info" | "warn" | "error";
  category: string;
  event: string;
  since: string;
  until: string;
  text: string;
  lookup: string;
};

export const DEFAULT_FILTERS: EventFilters = {
  severity: "info-and-above",
  category: "",
  event: "",
  since: "",
  until: "",
  text: "",
  lookup: "",
};

export const PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE = /^[0-9a-f]{8}$/i;

export function classifyLookup(
  value: string,
): { reference: string } | { runId: string } | { requestId: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (REFERENCE.test(trimmed)) return { reference: trimmed.toLowerCase() };
  if (UUID.test(trimmed)) return { runId: trimmed.toLowerCase() };
  return { requestId: trimmed.slice(0, 64) };
}

export const PROCESSING_CORRELATIONS = [
  "projectId",
  "generationId",
  "runId",
  "documentId",
  "fileId",
  "jobId",
] as const;
export type CorrelationFilters = Partial<
  Record<(typeof PROCESSING_CORRELATIONS)[number], string>
>;

export function correlationFromParams(params: {
  get(name: string): string | null;
}): CorrelationFilters {
  const result: CorrelationFilters = {};
  for (const key of PROCESSING_CORRELATIONS) {
    const value = params.get(key)?.trim();
    if (!value) continue;
    if (key === "jobId" ? value.length <= 64 : UUID.test(value))
      result[key] = key === "jobId" ? value : value.toLowerCase();
  }
  return result;
}

export function toListInput(
  filters: EventFilters,
  cursor: string | undefined,
  correlation: CorrelationFilters = {},
): ListDiagnosticEventsInput {
  const lookup = classifyLookup(filters.lookup);
  return {
    limit: PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
    ...(filters.severity === "info-and-above"
      ? { excludeDebug: true }
      : filters.severity === "all"
        ? {}
        : { severity: filters.severity }),
    ...(filters.category.trim() ? { category: filters.category.trim() } : {}),
    ...(filters.event.trim() ? { event: filters.event.trim() } : {}),
    ...(filters.since ? { since: new Date(filters.since) } : {}),
    ...(filters.until ? { until: new Date(filters.until) } : {}),
    ...(filters.text.trim() ? { text: filters.text.trim() } : {}),
    ...(lookup ?? {}),
    ...correlation,
  };
}
