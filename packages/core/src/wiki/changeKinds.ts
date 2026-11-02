export const WIKI_CHANGE_KINDS = [
  "ui",
  "mcp",
  "proposal",
  "task-run",
  "ingestion",
  "project-api",
  "exam",
  "wiki-run",
  "wiki-bootstrap",
  "wiki-input",
  "wiki-revert",
  "external",
] as const;
export type WikiChangeKind = (typeof WIKI_CHANGE_KINDS)[number];

const PREFIXED = WIKI_CHANGE_KINDS.filter(
  (kind) => kind !== "ui" && kind !== "external",
);

/** Only ledger-trusted commits get a kind from their operation id; everything else is external. */
export function changeKindOf(entry: {
  trustedAuthor?: boolean;
  operationId: string | null;
}): WikiChangeKind {
  if (entry.trustedAuthor !== true) return "external";
  if (entry.operationId === null) return "ui";
  const colon = entry.operationId.indexOf(":");
  const prefix = colon === -1 ? null : entry.operationId.slice(0, colon);
  return PREFIXED.find((kind) => kind === prefix) ?? "external";
}
