const EXACT_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "application/json": "JSON",
};

/** Short, human column label for a stored file. */
export function artifactTypeLabel(
  contentType: string,
  filename: string,
): string {
  if (contentType.includes("wordprocessingml")) return "Word";
  if (contentType.includes("spreadsheetml")) return "Excel";
  const exact = EXACT_LABELS[contentType];
  if (exact) return exact;
  if (contentType.startsWith("text/")) return "Text";
  if (contentType.startsWith("image/")) return "Image";
  const dot = filename.lastIndexOf(".");
  const extension = dot > 0 ? filename.slice(dot + 1) : "";
  return extension.length >= 1 && extension.length <= 8
    ? extension.toUpperCase()
    : "File";
}
