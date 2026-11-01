import { normalizeKnowledgeName } from "@weaver/core/knowledge/extraction";

export type ExistingEntityCandidate = {
  id: string;
  entityType: string;
  canonicalName: string;
  normalizedName: string;
  aliases: ReadonlyArray<
    | string
    | {
        alias: string;
        normalizedAlias?: string;
      }
  >;
};

export type ExtractedEntityCandidate = {
  name: string;
  type: string;
};

export function resolveEntityCandidates<T extends ExistingEntityCandidate>(
  existing: readonly T[],
  extracted: ExtractedEntityCandidate,
  options: { complete?: boolean } = {},
): T | null {
  if (options.complete === false) return null;
  const normalizedName = normalizeKnowledgeName(extracted.name);
  const normalizedType = normalizeKnowledgeName(extracted.type);
  const exact = existing.filter(
    (candidate) =>
      normalizeKnowledgeName(candidate.entityType) === normalizedType &&
      normalizeKnowledgeName(
        candidate.normalizedName || candidate.canonicalName,
      ) === normalizedName,
  );
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;
  const matches = existing.filter((candidate) => {
    if (normalizeKnowledgeName(candidate.entityType) !== normalizedType) {
      return false;
    }
    if (
      normalizeKnowledgeName(
        candidate.normalizedName || candidate.canonicalName,
      ) === normalizedName
    ) {
      return true;
    }
    return candidate.aliases.some((alias) =>
      typeof alias === "string"
        ? normalizeKnowledgeName(alias) === normalizedName
        : normalizeKnowledgeName(alias.normalizedAlias ?? alias.alias) ===
          normalizedName,
    );
  });

  return matches.length === 1 ? matches[0]! : null;
}
