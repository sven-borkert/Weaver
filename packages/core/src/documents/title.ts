import { z } from "zod";

export const documentTitleSchema = z
  .string()
  .trim()
  .min(1, "title must be trimmed and nonempty")
  .max(200, "title exceeds 200 characters")
  .refine(
    (value) => !/[\r\n\u2028\u2029\u0000]/.test(value),
    "title must be a single line",
  );
