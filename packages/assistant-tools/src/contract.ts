import type { PrismaClient } from "@weaver/db/client";
import type { SourceLocator } from "@weaver/core/assistant/citations";
import {
  assertInScope,
  type ScopeSnapshot,
} from "@weaver/core/assistant/scope";
import { isCoreError } from "@weaver/core/errors";
import type { ExternalRuntimeDeps } from "@weaver/core/externalMcp/types";
import type { AdminRuntimeConfig } from "@weaver/core/services/adminOverview";
import type { EncryptionKeyRing } from "@weaver/core/security/encryption";
import type {
  Capability,
  SecurityContext,
  UserSecurityContext,
} from "@weaver/core/security/context";
import type { z } from "zod";

/** A cap in UTF-8 BYTES (the unit the prompt budget charges), kept under its
 *  historical name: a CJK page of 16,000 characters would be 48,000 bytes. */
export const MAX_TOOL_OUTPUT_CHARS = 16_000;

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Longest prefix within maxBytes that ends on a code-point boundary; a lone surrogate costs the 3 bytes Buffer.byteLength charges it. */
export function utf8Prefix(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    let size = 3;
    let units = 1;
    if (code < 0x80) size = 1;
    else if (code < 0x800) size = 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < text.length &&
      (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00
    ) {
      size = 4;
      units = 2;
    }
    if (bytes + size > maxBytes) break;
    bytes += size;
    index += units;
  }
  return text.slice(0, index);
}

/** slice(0, units) that backs off a trailing high surrogate, so a cut never splits a pair. */
function codePointPrefix(text: string, units: number): string {
  let end = Math.min(units, text.length);
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return text.slice(0, end);
}

export type ToolContext = {
  db: PrismaClient;
  actor: UserSecurityContext;
  scope: ScopeSnapshot;
  profile: { name: string | null; email: string };
  run: { conversationId: string; runId: string; attemptId?: string } | null;
  signal?: AbortSignal;
  runtime?: { version: string; config: AdminRuntimeConfig };
  /** Present on the MCP server only; admin LLM tools need the ring and an injectable fetch. */
  llm?: { ring: EncryptionKeyRing | null; fetchImpl: typeof fetch };
  /** Present on the MCP server only; admin external-connection tools need it. */
  external?: ExternalRuntimeDeps;
};

/** Reads the wiki agent shares with users: only services accepting the union type-check here. */
export type SharedReadToolContext = Omit<ToolContext, "actor"> & {
  actor: SecurityContext;
};

export type ToolOutcome<O> = { output: O; citations?: SourceLocator[] };
export type ToolKind = "read" | "propose" | "write";

export type ToolContract<I, O> = {
  name: string;
  description: string;
  kind: ToolKind;
  capability: Capability;
  inputSchema: z.ZodType<I>;
  /** Overrides the MCP annotations derived from `kind`, for a tool whose
   *  effects differ from its kind (a read that enqueues work, for one). */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
  execute(input: I, ctx: ToolContext): Promise<ToolOutcome<O>>;
};
export type AnyToolContract = ToolContract<unknown, unknown>;

export function defineTool<I, O>(
  contract: ToolContract<I, O>,
): ToolContract<I, O> {
  return contract;
}

export function defineSharedReadTool<I, O>(
  contract: Omit<ToolContract<I, O>, "execute" | "kind"> & {
    kind: "read";
    execute(input: I, ctx: SharedReadToolContext): Promise<ToolOutcome<O>>;
  },
) {
  return contract;
}

export const TOOL_ERROR_CODES = [
  "SCOPE_VIOLATION",
  "FORBIDDEN",
  "NOT_FOUND",
  "BAD_REQUEST",
  "CONFLICT",
  "CANCELLED",
  "TOO_MANY_REQUESTS",
  "INTERNAL",
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/** Allowlisted structured reasons (concept §9); anything else stays a plain code + message. */
export const TOOL_ERROR_REASONS = [
  "INVALID_CURSOR",
  "SNAPSHOT_UNAVAILABLE",
  "STALE_BASE",
  "AMBIGUOUS_MATCH",
  "INVALID_FINAL_STATE",
  "PAYLOAD_TOO_LARGE",
  "FOLDER_NOT_FOUND",
] as const;
export type ToolErrorReason = (typeof TOOL_ERROR_REASONS)[number];

export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly reason?: ToolErrorReason,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

function allowlistedReason(details: unknown): ToolErrorReason | undefined {
  const reason =
    details && typeof details === "object" && "reason" in details
      ? (details as { reason?: unknown }).reason
      : undefined;
  return typeof reason === "string" &&
    (TOOL_ERROR_REASONS as readonly string[]).includes(reason)
    ? (reason as ToolErrorReason)
    : undefined;
}

const FOLDER_FIELDS = ["folderPath", "path", "parentPath", "newParentPath"];

function folderNotFoundMessage(field: unknown): string {
  const name =
    typeof field === "string" && FOLDER_FIELDS.includes(field)
      ? field
      : "folderPath";
  return `${name} names a folder that does not exist. Use a path from list_content_folders${
    name === "path" ? "" : ", or [] for the project root"
  }. Folders are never created implicitly: create one only when the user asked for it, and before writing into it.`;
}

/** Model-facing errors carry a stable code and a short safe message; internals are never forwarded. */
export function toolErrorFromUnknown(error: unknown): ToolError {
  if (error instanceof ToolError) return error;
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  )
    return new ToolError("CANCELLED", "tool cancelled");
  if (isCoreError(error)) {
    const rawReason =
      error.details && "reason" in error.details
        ? error.details.reason
        : undefined;
    const reason = allowlistedReason(error.details);
    if (error.code === "FORBIDDEN" && rawReason === "SCOPE_VIOLATION")
      return new ToolError(
        "SCOPE_VIOLATION",
        "resource is outside the conversation scope",
      );
    if (error.code === "FORBIDDEN")
      return new ToolError("FORBIDDEN", "not permitted");
    if (error.code === "NOT_FOUND" && reason === "FOLDER_NOT_FOUND")
      return new ToolError(
        "NOT_FOUND",
        folderNotFoundMessage(error.details?.field),
        reason,
      );
    if (error.code === "NOT_FOUND")
      return new ToolError("NOT_FOUND", "not found or not accessible", reason);
    if (error.code === "BAD_REQUEST")
      return new ToolError("BAD_REQUEST", error.message.slice(0, 300), reason);
    if (error.code === "CONFLICT" || error.code === "PRECONDITION_FAILED")
      return new ToolError("CONFLICT", error.message.slice(0, 300));
    if (error.code === "TOO_MANY_REQUESTS")
      return new ToolError(
        "TOO_MANY_REQUESTS",
        "too many file reads are in progress; try again shortly",
      );
  }
  return new ToolError("INTERNAL", "tool failed");
}

export function clampText(
  text: string,
  max = MAX_TOOL_OUTPUT_CHARS,
): { text: string; truncated: boolean } {
  const cut = utf8Prefix(text, max);
  return cut.length < text.length
    ? { text: cut, truncated: true }
    : { text, truncated: false };
}

export type TruncatedToolOutput = { truncated: true; partialJson: string };

/** Last-resort wrapper for an oversized result: fits the wrapper's OWN serialization, since transports serialize it again and that escaping can double a quote-dense payload. */
export function truncatedToolOutput(
  serialized: string,
  max = MAX_TOOL_OUTPUT_CHARS,
): TruncatedToolOutput {
  let low = 0;
  let high = serialized.length;
  let fitted: TruncatedToolOutput = { truncated: true, partialJson: "" };
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate: TruncatedToolOutput = {
      truncated: true,
      partialJson: codePointPrefix(serialized, middle),
    };
    if (utf8Bytes(JSON.stringify(candidate)) <= max) {
      fitted = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return fitted;
}

/** A running UTF-8 byte budget shared across one or more `boundItems` calls, so a tool result made of several arrays (e.g. search's documents/tables/entities) stays within one total. */
export type OutputBudget = { remaining: number };

export function newOutputBudget(max = MAX_TOOL_OUTPUT_CHARS): OutputBudget {
  return { remaining: max };
}

// Reserves room in a paged tool's own item budget for the envelope both
// transports serialize around it (ids, shas, nextCursor, hasMore, ...)
// before clamping the whole response at MAX_TOOL_OUTPUT_CHARS, so a page
// that fills its item budget never has its nextCursor clamped away with it.
// Bytes, like every other budget here.
export const PAGE_ENVELOPE_RESERVE_CHARS = 1_500;

export function newPageBudget(): OutputBudget {
  return newOutputBudget(MAX_TOOL_OUTPUT_CHARS - PAGE_ENVELOPE_RESERVE_CHARS);
}

/**
 * Keeps items, in order, while they fit the shared budget; drops the rest and
 * reports it instead of silently producing an oversized result. Field-level
 * bounds (excerpt length, page size, ...) keep this from firing in the
 * common case — this is the backstop for the aggregate.
 */
export function boundItems<T>(
  items: readonly T[],
  budget: OutputBudget,
): { items: T[]; truncated: boolean } {
  const kept: T[] = [];
  for (const item of items) {
    const size = utf8Bytes(JSON.stringify(item)) + 1;
    if (size > budget.remaining) return { items: kept, truncated: true };
    budget.remaining -= size;
    kept.push(item);
  }
  return { items: kept, truncated: false };
}

export function requireScope(
  ctx: Pick<ToolContext, "scope" | "signal">,
  projectId: string,
): void {
  ctx.signal?.throwIfAborted();
  assertInScope(ctx.scope, projectId);
}

export function scopedProjectIds(
  ctx: Pick<ToolContext, "scope" | "signal">,
  requested: string[] | undefined,
): string[] {
  ctx.signal?.throwIfAborted();
  if (!requested) return ctx.scope.projectIds;
  for (const id of requested) requireScope(ctx, id);
  return requested;
}
