import type { PrismaClient } from "@weaver/db/client";
import { CoreError } from "@weaver/core/errors";
import {
  collectImageSources,
  resolveRelativeImagePath,
} from "@weaver/core/documents/images";
import { MAX_MARKDOWN_CHARS } from "@weaver/core/documents/limits";
import { extractCrossrefTargets } from "@weaver/core/documents/links";
import {
  crossrefTargetKey,
  serializeDocumentBody,
} from "@weaver/core/editor/markdown";
import { readProjectImage } from "@weaver/core/services/documentImages";
import { getDocument, resolveRefs } from "@weaver/core/services/documents";
import type { ProjectActor } from "@weaver/core/services/projectAccess";
import { buildDocumentPrintHtml, hasMath, type PrintImage } from "./html";
import { mathStylesSource } from "./mathStyles";
import { getPdfRenderer, mermaidBundleSource } from "./render";

export const MAX_PDF_IMAGES = 100;
/** Total image bytes one export inlines; base64 grows them by a third inside one HTML string. */
export const MAX_PDF_IMAGE_BYTES = 64 * 1024 * 1024;

export class PdfLimitError extends Error {}

export async function exportDocumentPdf(
  db: PrismaClient,
  input: { projectId: string; documentId: string },
  actor: ProjectActor,
  options: { maxImageBytes?: number } = {},
): Promise<{ bytes: Uint8Array; filename: string }> {
  const maxImageBytes = options.maxImageBytes ?? MAX_PDF_IMAGE_BYTES;
  const document = await getDocument(db, input, actor);
  if (document.content.kind !== "markdown")
    throw new CoreError(
      "BAD_REQUEST",
      "PDF export is available for Markdown documents only",
    );
  const contentJson = document.content.contentJson;
  if (serializeDocumentBody(contentJson).length > MAX_MARKDOWN_CHARS)
    throw new PdfLimitError("document exceeds the export size limit");
  const sources = [...new Set(collectImageSources(contentJson))];
  if (sources.length > MAX_PDF_IMAGES)
    throw new PdfLimitError(
      `document references more than ${MAX_PDF_IMAGES} images`,
    );

  const images = new Map<string, PrintImage>();
  let imageBytes = 0;
  for (const src of sources) {
    const relPath = resolveRelativeImagePath(document.path, src);
    if (!relPath) continue;
    const served = await readProjectImage(
      db,
      {
        projectId: input.projectId,
        segments: relPath.split("/"),
        at: document.baseCommitSha,
      },
      actor,
    );
    if (!served) continue;
    imageBytes += served.bytes.byteLength;
    if (imageBytes > maxImageBytes)
      throw new PdfLimitError("document images exceed the export size limit");
    images.set(src, { contentType: served.contentType, bytes: served.bytes });
  }

  const targets = extractCrossrefTargets(contentJson);
  const crossrefTitles = new Map<string, string>();
  if (targets.length) {
    const rows = await resolveRefs(
      db,
      { projectId: input.projectId, ids: targets.map((t) => t.targetId) },
      actor,
    );
    for (const row of rows)
      if (row.exists)
        crossrefTitles.set(
          crossrefTargetKey(row.targetType, row.id),
          row.title,
        );
  }

  const html = buildDocumentPrintHtml({
    title: document.title,
    metadata: {
      createdAt: document.createdAt,
      createdBy: document.createdBy,
      updatedAt: document.updatedAt,
      updatedBy: document.updatedBy,
    },
    contentJson,
    images,
    crossrefTitles,
    mermaidScript: await mermaidBundleSource(),
    mathStyles: hasMath(contentJson) ? await mathStylesSource() : "",
  });
  return {
    bytes: await getPdfRenderer().render(html),
    filename: `${document.slug}.pdf`,
  };
}
