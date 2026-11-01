import { z } from "zod";

export const externalUrlSchema = z
  .string()
  .trim()
  .min(1, "Enter a URL")
  .url("Enter a valid URL")
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "Use an http:// or https:// URL");
