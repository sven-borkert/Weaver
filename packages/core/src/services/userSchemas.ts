import { z } from "zod";

// Re-exported, not redefined: @weaver/auth/constants is the single source of
// truth for global roles (Better Auth's role field is validated against it).
import {
  GLOBAL_ROLES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@weaver/auth/constants";
export {
  GLOBAL_ROLES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@weaver/auth/constants";
// Re-exported, not redefined: ../roles is the single source of truth for
// project role names.
import { PROJECT_ROLE_NAMES } from "../roles";
export const PROJECT_ROLES = PROJECT_ROLE_NAMES;

export const listUsersInput = z.object({
  search: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().max(2048).optional(),
});

export const userIdInput = z.object({ userId: z.uuid() });

export const createUserInput = z.object({
  email: z.email().max(320),
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine(
      (value) => !/[\u0000-\u001f\u007f]/.test(value),
      "Name cannot contain control characters",
    ),
  role: z.enum(GLOBAL_ROLES),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

export const setUserRoleInput = z.object({
  userId: z.uuid(),
  role: z.enum(GLOBAL_ROLES),
});

export const deactivateUserInput = z.object({
  userId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
});

export const resetPasswordInput = z.object({
  userId: z.uuid(),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

export const setMembershipInput = z.object({
  userId: z.uuid(),
  projectId: z.uuid(),
  role: z.enum(PROJECT_ROLE_NAMES).nullable(),
});
