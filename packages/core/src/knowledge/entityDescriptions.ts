export type EntityDescriptionSource = {
  documentId: string;
  description: string | null;
  confidence: number;
};

export function selectEntityDescription(
  sources: EntityDescriptionSource[],
): string | null {
  const supported = sources.filter((source) => source.description?.trim());
  supported.sort(
    (left, right) =>
      right.confidence - left.confidence ||
      left.documentId.localeCompare(right.documentId) ||
      Buffer.compare(
        Buffer.from(left.description!),
        Buffer.from(right.description!),
      ),
  );
  return supported[0]?.description ?? null;
}
