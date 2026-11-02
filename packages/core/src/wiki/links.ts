function escapeLabel(label: string): string {
  return label.replace(/\\/g, "\\\\").replace(/[[\]]/g, "\\$&");
}

/** The tracked cross-reference form; the label is kept current by the writer. */
export function trackedLink(
  kind: "document" | "table",
  id: string,
  title: string,
): string {
  const label = title.replace(/[\r\n\p{Zl}\p{Zp}]+/gu, " ").trim();
  return `[${escapeLabel(label || "Untitled")}](weaver://${kind}/${id})`;
}
