import type { NotebookBlock } from "@weaver/core/artifacts/notebookSchema";
import {
  imageReference,
  markdownImage,
} from "@weaver/core/documents/imageReferences";

/** Page text for the tools; images are Markdown image references a document
 *  write copies into the document (see `imageReferences.ts`). */
export function notebookPageText(
  blocks: readonly NotebookBlock[],
  artifactId: string,
): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case "text":
          return block.text;
        case "table":
          return block.rows.map((row) => row.join("\t")).join("\n");
        case "image":
          return markdownImage(
            block.alt,
            imageReference(artifactId, block.assetId),
          );
        case "attachment":
          return `[Attachment: ${block.name} (${block.byteSize} bytes)]`;
      }
    })
    .join("\n\n");
}
