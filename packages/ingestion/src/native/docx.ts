import { archiveIssue } from "./archive";
import * as mammoth from "mammoth";
import { emptyDocument, type ParseOutcome } from "../parser";
import { htmlToMarkdown } from "./htmlToMarkdown";

/** Word → HTML (mammoth) → Markdown (turndown). Images are counted and dropped in 5B. */
export async function parseDocx(bytes: Buffer): Promise<ParseOutcome> {
  const issue = archiveIssue(bytes);
  if (issue) return issue;
  let dropped = 0;
  let html: string;
  try {
    const result = await mammoth.convertToHtml(
      { buffer: bytes },
      {
        convertImage: mammoth.images.imgElement(async () => {
          dropped += 1;
          return { src: "" };
        }),
      },
    );
    html = result.value;
  } catch {
    return {
      failureKind: "parser",
      message: "the Word document could not be read",
    };
  }
  const markdown = htmlToMarkdown(html);
  if (markdown.trim().length === 0) {
    return {
      failureKind: "validation",
      message: "the document contains no text",
    };
  }
  const warnings =
    dropped === 0
      ? []
      : [
          `${dropped} embedded image${dropped === 1 ? " was" : "s were"} not imported`,
        ];
  return emptyDocument(markdown, warnings);
}
