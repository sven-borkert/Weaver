import { normalizeAppearance, type Appearance } from "../appearance/metadata";
import {
  normalizeFolderReviewDefaults,
  type StoredFolderReviewDefaults,
} from "./folderReview";
import { assertAuthorName, type DocumentAuthor } from "./frontmatter";

/** Per-folder display name and create/update stamps kept in Git beside the folder's content. */
export const FOLDER_METADATA_FILE = ".folder.json";
export const MAX_FOLDER_NAME_LENGTH = 120;

export function folderMetadataPath(folderRel: string): string {
  return folderRel.length > 0
    ? `${folderRel}/${FOLDER_METADATA_FILE}`
    : FOLDER_METADATA_FILE;
}

/** Files a folder may contain and still count as empty. */
export function isFolderMarkerFile(fileName: string): boolean {
  return fileName === ".gitkeep" || fileName === FOLDER_METADATA_FILE;
}

/** The trimmed display name, or null when it is empty, too long, or not a single line. */
export function normalizeFolderName(value: string): string | null {
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_FOLDER_NAME_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/** `created`/`updated` and their authors are null only in files written before they were recorded. */
export type FolderMetadata = {
  id?: string;
  name: string;
  created: string | null;
  createdBy: DocumentAuthor | null;
  updated: string | null;
  updatedBy: DocumentAuthor | null;
  appearance?: Appearance;
  reviewDefaults?: StoredFolderReviewDefaults;
};

/** Metadata of a folder created now by `author`. */
export function newFolderMetadata(
  name: string,
  author: DocumentAuthor,
  now: Date,
  id: string = globalThis.crypto.randomUUID(),
): FolderMetadata {
  const at = now.toISOString();
  return {
    id,
    name,
    created: at,
    createdBy: author,
    updated: at,
    updatedBy: author,
  };
}

export function composeFolderMetadata(meta: FolderMetadata): string {
  const { name, created, createdBy, updated, updatedBy } = meta;
  const appearance = normalizeAppearance(meta.appearance);
  const reviewDefaults = normalizeFolderReviewDefaults(meta.reviewDefaults);
  return `${JSON.stringify(
    {
      ...(meta.id ? { id: meta.id } : {}),
      name,
      ...(created ? { created } : {}),
      ...(createdBy ? { createdBy } : {}),
      ...(updated ? { updated } : {}),
      ...(updatedBy ? { updatedBy } : {}),
      ...(appearance === null ? {} : { appearance }),
      ...(reviewDefaults === null ? {} : { reviewDefaults }),
    },
    null,
    2,
  )}\n`;
}

function parseTimestamp(raw: unknown): string | null {
  if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) return null;
  return new Date(raw).toISOString();
}

function parseAuthor(raw: unknown): DocumentAuthor | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { id, name } = raw as { id?: unknown; name?: unknown };
  if (typeof name !== "string" || (id !== null && typeof id !== "string"))
    return null;
  try {
    assertAuthorName(name);
  } catch {
    return null;
  }
  return { id, name };
}

export type RootFolderMetadata = {
  reviewDefaults?: StoredFolderReviewDefaults;
};

export function composeRootFolderMetadata(meta: RootFolderMetadata): string {
  const reviewDefaults = normalizeFolderReviewDefaults(meta.reviewDefaults);
  return `${JSON.stringify(reviewDefaults === null ? {} : { reviewDefaults }, null, 2)}\n`;
}

function parseMetadataObject(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return null;
  return parsed as Record<string, unknown>;
}

/** Document-root metadata stores defaults only, without a visible folder identity. */
export function parseRootFolderMetadata(
  text: string,
): RootFolderMetadata | null {
  const raw = parseMetadataObject(text);
  if (raw === null) return null;
  const reviewDefaults = normalizeFolderReviewDefaults(raw.reviewDefaults);
  return reviewDefaults === null ? {} : { reviewDefaults };
}

/** Null when the file has no usable name; unreadable optional fields are dropped. */
export function parseFolderMetadata(text: string): FolderMetadata | null {
  const raw = parseMetadataObject(text);
  if (raw === null) return null;
  if (typeof raw.name !== "string") return null;
  const name = normalizeFolderName(raw.name);
  if (name === null) return null;
  const appearance = normalizeAppearance(raw.appearance);
  const reviewDefaults = normalizeFolderReviewDefaults(raw.reviewDefaults);
  return {
    ...(typeof raw.id === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      raw.id,
    )
      ? { id: raw.id }
      : {}),
    ...(reviewDefaults === null ? {} : { reviewDefaults }),
    ...(appearance === null ? {} : { appearance }),
    name,
    created: parseTimestamp(raw.created),
    createdBy: parseAuthor(raw.createdBy),
    updated: parseTimestamp(raw.updated),
    updatedBy: parseAuthor(raw.updatedBy),
  };
}
