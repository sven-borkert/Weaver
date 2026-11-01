import { z } from "zod";

export const projectIdInput = z.object({ projectId: z.uuid() });

export const createProjectInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine(
      (value) => !/[\u0000-\u001f\u007f]/.test(value),
      "Name must be a single line without control characters",
    ),
  description: z.string().trim().max(2000).optional(),
});

export const updateProjectInput = z
  .object({
    projectId: z.uuid(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine(
        (value) => !/[\u0000-\u001f\u007f]/.test(value),
        "Name must be a single line without control characters",
      )
      .optional(),
    description: z.string().trim().max(2000).nullable().optional(),
  })
  .refine(
    (input) => input.name !== undefined || input.description !== undefined,
    { message: "At least one of name or description must be provided" },
  );
