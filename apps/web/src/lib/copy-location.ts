/**
 * Plain-text location of a document or table, pasted into an MCP prompt.
 * The names say which item it is; the IDs make the target unambiguous.
 */
export function formatItemLocation(input: {
  projectName: string;
  projectId: string;
  /** Folder display names from the project root, outermost first. */
  folder: string[];
  kind: "Document" | "Table";
  title: string;
  itemId: string;
}): string {
  return [
    `Project: ${input.projectName}`,
    `Folder: ${input.folder.length > 0 ? input.folder.join(" / ") : "(project root)"}`,
    `${input.kind}: ${input.title}`,
    `Project ID: ${input.projectId}`,
    `${input.kind} ID: ${input.itemId}`,
  ].join("\n");
}
