import { z } from "zod";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_ARGUMENT_BYTES,
  MAX_BULK_TOOL_REVIEWS,
  MAX_ENDPOINT_LENGTH,
  MAX_EXTERNAL_CONNECTIONS,
  MAX_EXTERNAL_INPUTS,
  MAX_EXTERNAL_TOOLS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
} from "./limits";

const uuid = z.uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/i);
const authMode = z.enum(["none", "bearer"]);
const timeoutMs = z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS);
const jsonValueSchema = z.json();
const utf8Bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

export const externalEndpointSchema = z
  .string()
  .max(MAX_ENDPOINT_LENGTH)
  .url()
  .superRefine((value, ctx) => {
    const url = URL.parse(value);
    if (!url) return;
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      ctx.addIssue({
        code: "custom",
        message: "Endpoint must use HTTP or HTTPS",
      });
    }
    if (url.username || url.password) {
      ctx.addIssue({
        code: "custom",
        message: "Endpoint must not contain credentials",
      });
    }
    if (url.hash) {
      ctx.addIssue({
        code: "custom",
        message: "Endpoint must not contain a fragment",
      });
    }
  });

const connectionFields = {
  name: z.string().trim().min(1).max(120),
  endpoint: externalEndpointSchema,
  authMode,
  token: z.string().min(1).max(16_384).optional(),
  timeoutMs: timeoutMs.default(DEFAULT_TIMEOUT_MS),
  allowInsecureTls: z.boolean().default(false),
};

export const connectionCreateSchema = z
  .strictObject({ ...connectionFields, enabled: z.boolean().default(false) })
  .superRefine((value, ctx) => {
    if (value.authMode === "bearer" && !value.token) {
      ctx.addIssue({
        code: "custom",
        path: ["token"],
        message: "Bearer token is required",
      });
    }
    if (value.authMode === "none" && value.token !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["token"],
        message: "Token is not allowed without authentication",
      });
    }
  });

export const connectionUpdateSchema = z
  .strictObject({
    name: connectionFields.name.optional(),
    endpoint: connectionFields.endpoint.optional(),
    authMode: connectionFields.authMode.optional(),
    token: connectionFields.token,
    timeoutMs: timeoutMs.optional(),
    enabled: z.boolean().optional(),
    allowInsecureTls: z.boolean().optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one change is required",
  )
  .superRefine((value, ctx) => {
    if (value.authMode === "none" && value.token !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["token"],
        message: "Token is not allowed without authentication",
      });
    }
  });

const selectionSchema = z.strictObject({
  connectionId: uuid,
  toolIds: z
    .array(uuid)
    .max(MAX_EXTERNAL_TOOLS)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Tool IDs must be unique",
    ),
});

export const externalSelectionSchema = z
  .array(selectionSchema)
  .max(MAX_EXTERNAL_CONNECTIONS)
  .refine(
    (items) =>
      new Set(items.map((item) => item.connectionId)).size === items.length,
    "Connection IDs must be unique",
  )
  .refine(
    (items) =>
      items.reduce((sum, item) => sum + item.toolIds.length, 0) <=
      MAX_EXTERNAL_TOOLS,
    `At most ${MAX_EXTERNAL_TOOLS} tools may be selected`,
  )
  .default([]);

const argumentBindingSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("literal"), value: jsonValueSchema }),
  z.strictObject({ kind: z.literal("period_start") }),
  z.strictObject({ kind: z.literal("period_end") }),
]);

const inputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    toolId: uuid,
    arguments: z.record(z.string().min(1), argumentBindingSchema),
  })
  .refine(
    (input) => utf8Bytes(input.arguments) <= MAX_ARGUMENT_BYTES,
    `Arguments must be at most ${MAX_ARGUMENT_BYTES} UTF-8 bytes`,
  );

export const externalInputSchema = z
  .array(inputSchema)
  .max(MAX_EXTERNAL_INPUTS)
  .refine(
    (items) =>
      new Set(items.map((item) => item.name.toLocaleLowerCase())).size ===
      items.length,
    "Input names must be unique",
  )
  .default([]);

export const toolFilterSchema = z.object({
  connectionId: uuid,
  search: z.string().trim().min(1).max(300).optional(),
  reviewState: z
    .enum(["unreviewed", "changed", "reviewed", "removed", "unsupported"])
    .optional(),
  effect: z.enum(["read", "write"]).optional(),
  enabled: z.boolean().optional(),
  /** Current definition carries `readOnlyHint: true`, whatever the reviewed effect. */
  suggestedEffect: z.literal("read").optional(),
});

export const toolBulkReviewSchema = z.strictObject({
  connectionId: uuid,
  items: z
    .array(
      z.strictObject({
        toolId: uuid,
        expectedRemoteDigest: digest,
        enabled: z.boolean().optional(),
        effect: z.enum(["read", "write"]).optional(),
      }),
    )
    .min(1)
    .max(MAX_BULK_TOOL_REVIEWS)
    .refine(
      (items) =>
        new Set(items.map((item) => item.toolId)).size === items.length,
      "Tool IDs must be unique",
    ),
});

export const approvalDecisionSchema = z.strictObject({
  approvalId: uuid,
  decision: z.enum(["approve", "deny"]),
});

export const externalToolSnapshotSchema = z.object({
  connectionId: z.uuid(),
  toolId: z.uuid(),
  configRevision: z.number().int().positive(),
  toolDigest: z.string(),
});
export type ExternalToolSnapshot = z.infer<typeof externalToolSnapshotSchema>;
export const externalToolSnapshotsSchema = z
  .array(externalToolSnapshotSchema)
  .max(MAX_EXTERNAL_TOOLS);
