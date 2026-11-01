import { z } from "zod";
import type { AppearancePatch } from "@weaver/core/appearance/metadata";
import { assertSafeSegments } from "@weaver/core/documents/paths";

const projectId = z.uuid();
const item = { projectId, id: z.uuid() };
export const appearanceTarget = z.discriminatedUnion("kind", [
  z.object({ ...item, kind: z.literal("document") }).strict(),
  z.object({ ...item, kind: z.literal("table") }).strict(),
  z
    .object({
      projectId,
      kind: z.literal("folder"),
      scope: z.enum(["documents", "tables"]),
      path: z.array(z.string()).superRefine((path, ctx) => {
        try {
          assertSafeSegments(path);
        } catch {
          ctx.addIssue({ code: "custom", message: "Invalid folder path" });
        }
      }),
    })
    .strict(),
]);
export const getAppearanceInput = z.object({ target: appearanceTarget });
export const setAppearanceInput = getAppearanceInput.extend({
  expectedRevision: z.string().regex(/^[a-f0-9]{40}$/),
  patch: z.unknown().transform((value) => value as AppearancePatch),
});
