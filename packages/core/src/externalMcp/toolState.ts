export type ExternalToolState =
  "new" | "changed" | "reviewed" | "unavailable" | "unsupported";

export function externalToolState(tool: {
  presentInCatalog: boolean;
  reviewedRemoteDigest: string | null;
  discoveredRemoteDigest: string;
  discoveredDefinition: unknown;
}): ExternalToolState {
  if (!tool.presentInCatalog) return "unavailable";
  const definition = tool.discoveredDefinition as {
    supportStatus?: { available?: boolean };
  } | null;
  if (definition?.supportStatus?.available === false) return "unsupported";
  if (!tool.reviewedRemoteDigest) return "new";
  return tool.reviewedRemoteDigest === tool.discoveredRemoteDigest
    ? "reviewed"
    : "changed";
}

export function suggestedToolEffect(definition: unknown): "read" | "write" {
  if (typeof definition !== "object" || definition === null) return "write";
  const annotations = (definition as { annotations?: unknown }).annotations;
  return typeof annotations === "object" &&
    annotations !== null &&
    (annotations as { readOnlyHint?: unknown }).readOnlyHint === true
    ? "read"
    : "write";
}
