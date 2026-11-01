import {
  assertAppearancePatch,
  normalizeAppearance,
} from "@weaver/core/appearance/metadata";
import { z } from "zod";
import { documentTitleSchema } from "@weaver/core/documents/title";
import {
  TRANSFER_IMAGE_NAME_RE,
  TRANSFER_MAX_IMAGES,
} from "@weaver/core/services/remoteInstances";
import { folderPathSchema } from "~/server/api/schemas/folder";
import {
  tableColumnsSchema,
  tableRowsSchema,
} from "~/server/api/schemas/table";

const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);

const appearanceFields = {
  appearance: z
    .unknown()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return undefined;
      try {
        assertAppearancePatch(value);
        return normalizeAppearance(value) ?? undefined;
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid appearance" });
        return z.NEVER;
      }
    }),
  iconAssets: z
    .array(
      z.object({
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        extension: z.enum(["png", "jpg", "webp"]),
        bytes: base64.max(2796204),
      }),
    )
    .max(1)
    .optional(),
};

export const transferDocumentInput = z.object({
  ...appearanceFields,
  projectId: z.uuid(),
  folderPath: folderPathSchema,
  title: documentTitleSchema,
  markdown: z.string(),
  assetsSlug: z.string().min(1).max(80),
  images: z
    .array(
      z.object({
        name: z.string().regex(TRANSFER_IMAGE_NAME_RE),
        contentType: z.string(),
        bytes: base64,
      }),
    )
    .max(TRANSFER_MAX_IMAGES),
});

export const transferTableInput = z.object({
  ...appearanceFields,
  projectId: z.uuid(),
  folderPath: folderPathSchema,
  title: documentTitleSchema,
  columns: tableColumnsSchema,
  rows: tableRowsSchema,
});
