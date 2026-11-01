import { isIconAssetPath } from "@weaver/core/appearance/icons";
import {
  parseFolderMetadata,
  type FolderMetadata,
} from "@weaver/core/documents/folderMetadata";
import type { DocumentKind } from "@weaver/core/documents/kinds";
import { decodeUtf8Strict } from "@weaver/core/documents/text";
import {
  MAX_ICON_BYTES,
  validateAppearanceAssets,
  type AppearanceAsset,
} from "@weaver/core/services/appearanceAssets";
import { z } from "zod";
import {
  MAX_IMPORTED_IMAGES,
  MAX_IMPORT_IMAGE_BYTES,
  MAX_MARKDOWN_CHARS,
} from "@weaver/core/documents/limits";
import { MAX_FOLDER_DEPTH, SEGMENT_RE } from "@weaver/core/documents/paths";
import { UUID_RE } from "@weaver/core/ingestion/paths";
import type {
  ArchiveImportImage,
  ArchiveImportTarget,
} from "@weaver/core/services/documentImport";
import { UploadProblem } from "~/server/ingestion/multipartUpload";

const MAX_MARKDOWN_BYTES = MAX_MARKDOWN_CHARS * 4;

/** Document text, images and multipart framing of one document. */
export const MAX_ARCHIVE_IMPORT_BODY_BYTES =
  MAX_MARKDOWN_BYTES + MAX_IMPORT_IMAGE_BYTES + 1024 ** 2;

export type ParsedArchiveImport = {
  folderPath: string[];
  folderNames: Record<string, string>;
  target: ArchiveImportTarget | { mode: "folders" };
  folderMetadata: Record<string, FolderMetadata>;
  iconAssets: AppearanceAsset[];
  kind: DocumentKind;
  fileName: string;
  text: string;
  images: ArchiveImportImage[];
};

const fieldsSchema = z.object({
  folderPath: z.array(z.string().regex(SEGMENT_RE)).max(MAX_FOLDER_DEPTH),
  folderNames: z.record(z.string().max(1_000), z.string().max(200)),
  mode: z.enum(["create", "replace", "folders"]),
  targetDocumentId: z.string().regex(UUID_RE).optional(),
  expectedHeadCommitSha: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
});

function json(form: FormData, name: string): unknown {
  const value = form.get(name);
  if (typeof value !== "string")
    throw new UploadProblem(400, `${name} is required`);
  if (new TextEncoder().encode(value).byteLength > 1024 ** 2)
    throw new UploadProblem(413, `${name} exceeds the metadata size limit`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new UploadProblem(400, `${name} is not valid JSON`);
  }
}

function decodedText(buffer: ArrayBuffer): string {
  const text = decodeUtf8Strict(new Uint8Array(buffer));
  if (text === null) throw new UploadProblem(400, "the file is not UTF-8 text");
  return text;
}

/** Validates one document's import form and reads its files into memory. */
export async function parseArchiveImportForm(
  form: FormData,
): Promise<ParsedArchiveImport> {
  const fields = fieldsSchema.safeParse({
    folderPath: json(form, "folderPath"),
    folderNames: json(form, "folderNames"),
    mode: form.get("mode"),
    targetDocumentId: form.get("targetDocumentId") ?? undefined,
    expectedHeadCommitSha: form.get("expectedHeadCommitSha") ?? undefined,
  });
  if (!fields.success) throw new UploadProblem(400, "invalid import fields");
  const {
    folderPath,
    folderNames,
    mode,
    targetDocumentId,
    expectedHeadCommitSha,
  } = fields.data;
  if (
    (mode === "replace") !== (targetDocumentId !== undefined) ||
    (mode === "replace") !== (expectedHeadCommitSha !== undefined)
  )
    throw new UploadProblem(
      400,
      "targetDocumentId belongs to replace and only to replace",
    );
  const folderMetadata: Record<string, FolderMetadata> = {};
  if (form.has("folderMetadata")) {
    const raw = json(form, "folderMetadata");
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).length > 1000
    )
      throw new UploadProblem(400, "invalid folder metadata");
    for (const [path, value] of Object.entries(raw)) {
      if (
        !path ||
        path.split("/").length > MAX_FOLDER_DEPTH ||
        path.split("/").some((segment) => !SEGMENT_RE.test(segment)) ||
        path.split("/")[0] === "tables"
      )
        throw new UploadProblem(400, "invalid folder metadata path");
      const parsed = parseFolderMetadata(JSON.stringify(value));
      if (!parsed) throw new UploadProblem(400, "invalid folder metadata");
      folderMetadata[path] = parsed;
    }
  }
  const documentParts = (["markdown", "python"] as const).flatMap((kind) =>
    form.getAll(kind).map((part) => ({ kind, part })),
  );
  const document = documentParts[0];
  if (
    mode !== "folders" &&
    (documentParts.length !== 1 || !(document!.part instanceof File))
  )
    throw new UploadProblem(
      400,
      "exactly one markdown or python file is required",
    );
  if (document?.part instanceof File && document.part.size > MAX_MARKDOWN_BYTES)
    throw new UploadProblem(413, "the file exceeds the import size limit");
  const imageParts = form.getAll("image");
  if (imageParts.length > MAX_IMPORTED_IMAGES)
    throw new UploadProblem(413, "a document may carry at most 100 images");
  if (
    mode === "folders" &&
    (documentParts.length ||
      imageParts.length ||
      !Object.keys(folderMetadata).length)
  )
    throw new UploadProblem(
      400,
      "folder imports require metadata and no document files",
    );
  const images: ArchiveImportImage[] = [];
  let imageBytes = 0;
  for (const part of imageParts) {
    if (!(part instanceof File))
      throw new UploadProblem(400, "image parts must be files");
    imageBytes += part.size;
    if (imageBytes > MAX_IMPORT_IMAGE_BYTES)
      throw new UploadProblem(413, "images exceed 64 MiB in total");
    images.push({
      name: part.name,
      bytes: new Uint8Array(await part.arrayBuffer()),
    });
  }
  const iconAssets: AppearanceAsset[] = [];
  const iconParts = form.getAll("icon");
  if (iconParts.length > 100)
    throw new UploadProblem(413, "too many icon assets");
  for (const part of iconParts) {
    if (
      !(part instanceof File) ||
      !isIconAssetPath(`.weaver-icons/${part.name}`)
    )
      throw new UploadProblem(400, "invalid icon part");
    imageBytes += part.size;
    if (part.size > MAX_ICON_BYTES || imageBytes > MAX_IMPORT_IMAGE_BYTES)
      throw new UploadProblem(
        413,
        "icon or combined image size limit exceeded",
      );
    const [digest, extension] = part.name.split(".");
    iconAssets.push({
      digest: digest!,
      extension: extension as AppearanceAsset["extension"],
      bytes: new Uint8Array(await part.arrayBuffer()),
    });
  }
  validateAppearanceAssets(iconAssets);
  return {
    folderPath,
    folderNames,
    folderMetadata,
    iconAssets,
    target:
      mode === "replace"
        ? {
            mode,
            documentId: targetDocumentId!,
            expectedHeadCommitSha: expectedHeadCommitSha!,
          }
        : { mode },
    kind: document?.kind ?? "markdown",
    fileName: document?.part instanceof File ? document.part.name : "",
    text:
      document?.part instanceof File
        ? decodedText(await document.part.arrayBuffer())
        : "",
    images,
  };
}
