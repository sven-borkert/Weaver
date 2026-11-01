import { z } from "zod";

export const NOTEBOOK_PARSER_VERSION = 3;
export const NOTEBOOK_TIMEOUT_MS = 5 * 60_000;
export const NOTEBOOK_MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
export const NOTEBOOK_PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const NOTEBOOK_ASSET_MAX_BYTES = 32 * 1024 * 1024;
export const NOTEBOOK_SNAPSHOT_MAX_BYTES = 512 * 1024 * 1024;
/** A failed preparation may be rebuilt with `retry` only once this has passed
 *  since the failure was recorded, so a deterministically failing notebook
 *  cannot monopolise the single preparation slot. */
export const NOTEBOOK_RETRY_COOLDOWN_MS = 10 * 60_000;
export const notebookIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,96}$/);
export const notebookDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const warning = z.string().max(500);

export const notebookBlockSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), text: z.string().max(200_000) }),
  z.strictObject({
    kind: z.literal("table"),
    rows: z.array(z.array(z.string().max(20_000)).max(200)).max(5_000),
  }),
  z.strictObject({
    kind: z.literal("image"),
    assetId: notebookDigestSchema,
    alt: z.string().max(1_000),
  }),
  z.strictObject({
    kind: z.literal("attachment"),
    name: z.string().max(500),
    byteSize: z.number().int().nonnegative(),
  }),
]);

export const notebookPageSchema = z.strictObject({
  id: notebookIdSchema,
  sectionId: notebookIdSchema,
  title: z.string().max(1_000),
  level: z.number().int().min(0).max(20),
  blocks: z.array(notebookBlockSchema).max(25_000),
  warnings: z.array(warning).max(100),
});

export const notebookManifestSchema = z.strictObject({
  schemaVersion: z.literal(2),
  sections: z
    .array(
      z.strictObject({
        id: notebookIdSchema,
        title: z.string().max(1_000),
        path: z.array(z.string().max(255)).max(20),
        pages: z
          .array(
            z.strictObject({
              id: notebookIdSchema,
              title: z.string().max(1_000),
              level: z.number().int().min(0).max(20),
              text: z.string().max(200_000),
            }),
          )
          .max(20_000),
        warnings: z.array(warning).max(100),
        content: z.enum(["parsed", "empty", "unreadable"]),
      }),
    )
    .max(1_000),
  assets: z
    .array(
      z.strictObject({
        id: notebookDigestSchema,
        contentType: z.enum([
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/gif",
        ]),
        byteSize: z.number().int().min(1).max(NOTEBOOK_ASSET_MAX_BYTES),
      }),
    )
    .max(20_000),
  warnings: z.array(warning).max(100),
});

export type NotebookBlock = z.infer<typeof notebookBlockSchema>;
export type NotebookPage = z.infer<typeof notebookPageSchema>;
export type NotebookManifest = z.infer<typeof notebookManifestSchema>;
export type NotebookStatus =
  "unprepared" | "queued" | "running" | "ready" | "failed";

/** User-facing text for `ArtifactNotebook.error` codes. */
export const NOTEBOOK_ERROR_MESSAGES: Record<string, string> = {
  parse_failed: "The notebook could not be read.",
  parse_timeout: "Reading the notebook took longer than the time limit.",
  quota_exceeded:
    "The prepared notebook would exceed the project storage quota.",
  snapshot_unavailable:
    "The prepared notebook is no longer stored; reading it prepares it again.",
};

export function notebookErrorMessage(code: string | null): string | null {
  if (code === null) return null;
  return NOTEBOOK_ERROR_MESSAGES[code] ?? "Preparing the notebook failed.";
}

export function isNotebookFilename(filename: string): boolean {
  return /\.(one|onepkg)$/i.test(filename);
}
