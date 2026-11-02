import type { Appearance } from "../appearance/metadata";
import { FrontmatterError, parseDocumentFile } from "./frontmatter";
import { documentFileStem } from "./kinds";
import { importedProperties } from "./importProperties";
import type { WikiPagePropertiesInput } from "../wiki/properties";
import type { DocumentReview } from "./review";
import { normalizeDocumentText } from "./text";

const TITLE_MAX = 200;

function sanitizeTitle(value: string): string {
  return value
    .replace(/[\r\n\u2028\u2029\u0000]+/g, " ")
    .trim()
    .slice(0, TITLE_MAX)
    .trim();
}

/** The uploaded file's stem, verbatim, so `deploy_prod.py` keeps its name. */
export function pythonTitleFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, "");
  const stem = /\.py$/i.test(base) ? base.slice(0, -3) : documentFileStem(base);
  return sanitizeTitle(stem) || "Untitled import";
}

/** Title, body and the reusable metadata of an uploaded Python file. */
export function splitPythonImport(
  text: string,
  fileName: string,
): {
  title: string;
  body: string;
  review: DocumentReview | null;
  appearance: Appearance | undefined;
  properties: WikiPagePropertiesInput | undefined;
} {
  const normalized = normalizeDocumentText(text);
  try {
    const parsed = parseDocumentFile(normalized, "python");
    return {
      title:
        sanitizeTitle(parsed.meta.title) || pythonTitleFromFileName(fileName),
      body: parsed.body,
      review: parsed.meta.review,
      appearance: parsed.meta.appearance,
      properties: importedProperties(normalized, "python"),
    };
  } catch (error) {
    if (!(error instanceof FrontmatterError)) throw error;
    return {
      title: pythonTitleFromFileName(fileName),
      body: normalized,
      review: null,
      appearance: undefined,
      properties: undefined,
    };
  }
}
