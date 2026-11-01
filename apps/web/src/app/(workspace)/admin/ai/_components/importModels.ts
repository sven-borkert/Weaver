import type { capabilities } from "./llmSchemas";

// Pure helpers for ImportModelsDialog; structural types keep this testable in node.
export type Capability = (typeof capabilities)[number];

export type DiscoveredModelLike = {
  providerModelId: string;
  displayName: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  embeddingDimensions: number | null;
  capabilities: Capability[];
  source: "endpoint" | "catalog" | "inferred";
};

export type ImportRow = DiscoveredModelLike & { declared: boolean };

export type ImportModelInput = {
  providerModelId: string;
  displayName: string;
  capabilities: Capability[];
  contextWindow: number | null;
  maxOutputTokens: number | null;
  embeddingDimensions: number | null;
};

export function buildImportRows(
  discovered: readonly DiscoveredModelLike[],
  declaredProviderModelIds: Iterable<string>,
): ImportRow[] {
  const declared = new Set(declaredProviderModelIds);
  const seen = new Set<string>();
  const rows: ImportRow[] = [];
  for (const model of discovered) {
    if (seen.has(model.providerModelId)) continue;
    seen.add(model.providerModelId);
    rows.push({ ...model, declared: declared.has(model.providerModelId) });
  }
  return rows;
}

// The import schema needs at least one capability; discovery keeps non-LLM
// models (speech, image) with none so the list still shows them.
export function isImportable(row: ImportRow): boolean {
  return row.capabilities.length > 0;
}

export function initialImportSelection(
  rows: readonly ImportRow[],
): Set<string> {
  return new Set(
    rows
      .filter((row) => !row.declared && isImportable(row))
      .map((row) => row.providerModelId),
  );
}

export function filterImportRows(
  rows: readonly ImportRow[],
  filter: string,
): ImportRow[] {
  const query = filter.trim().toLowerCase();
  if (query === "") return [...rows];
  return rows.filter(
    (row) =>
      row.providerModelId.toLowerCase().includes(query) ||
      row.displayName.toLowerCase().includes(query),
  );
}

export function isRowSelectable(row: ImportRow, updateExisting: boolean) {
  return isImportable(row) && (!row.declared || updateExisting);
}

export function toggleVisibleSelection(
  selected: ReadonlySet<string>,
  visible: readonly ImportRow[],
  updateExisting: boolean,
  checked: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const row of visible) {
    if (!isRowSelectable(row, updateExisting)) continue;
    if (checked) next.add(row.providerModelId);
    else next.delete(row.providerModelId);
  }
  return next;
}

export function selectionForUpdateExisting(
  selected: ReadonlySet<string>,
  rows: readonly ImportRow[],
  updateExisting: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const row of rows) {
    if (!row.declared) continue;
    if (updateExisting && !isImportable(row)) continue;
    if (updateExisting) next.add(row.providerModelId);
    else next.delete(row.providerModelId);
  }
  return next;
}

export function importPayload(
  rows: readonly ImportRow[],
  selected: ReadonlySet<string>,
): ImportModelInput[] {
  return rows
    .filter((row) => selected.has(row.providerModelId) && isImportable(row))
    .map((row) => ({
      providerModelId: row.providerModelId,
      displayName: row.displayName,
      capabilities: row.capabilities,
      contextWindow: row.contextWindow,
      maxOutputTokens: row.maxOutputTokens,
      embeddingDimensions: row.embeddingDimensions,
    }));
}

const noun = (count: number) => (count === 1 ? "model" : "models");

export function importButtonLabel(count: number): string {
  return count === 0 ? "Import models" : `Import ${count} ${noun(count)}`;
}

export function importResultSummary(result: {
  created: number;
  updated: number;
}): string {
  if (result.created > 0 && result.updated > 0) {
    return `Imported ${result.created} ${noun(result.created)}, updated ${result.updated}`;
  }
  if (result.created > 0)
    return `Imported ${result.created} ${noun(result.created)}`;
  if (result.updated > 0)
    return `Updated ${result.updated} ${noun(result.updated)}`;
  return "No models imported";
}
