const RAW_CORE_ERROR_CODES = new Set([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "TOO_MANY_REQUESTS",
  "INTERNAL_SERVER_ERROR",
]);

/**
 * `CoreError`'s message defaults to its bare code (e.g. "NOT_FOUND") when a
 * service throws without an explicit one — `requireOwnedConversation`'s
 * NOT_FOUND and `assertAssistantUse`'s FORBIDDEN both do this
 * (packages/core/src/services/assistantConversations.ts). Toasting that
 * verbatim reads as a bug: a cross-tab delete then surfaces the literal
 * string "NOT_FOUND" to the user. Every toast that would otherwise fall
 * through to `err.message` routes through this first.
 */
export function humanAssistantError(
  message: string | undefined,
  fallback: string,
): string {
  const trimmed = message?.trim();
  if (!trimmed) return fallback;
  return RAW_CORE_ERROR_CODES.has(trimmed) ? fallback : trimmed;
}

type QueryErrorShape = { data?: { code?: string } | null } | null | undefined;

/**
 * Whether a `getConversation` failure means "this conversation is not yours
 * to see" rather than a transient problem. Spec §10 requires this state to
 * both render "This conversation isn't available" and clear the stored
 * `activeConversationId`, so the docked panel cannot sit forever on an id
 * that no longer resolves (deleted in another tab, or pasted from someone
 * else's URL). Pure so the node test environment can assert it.
 */
export function isConversationUnavailable(error: unknown): boolean {
  const code = (error as QueryErrorShape)?.data?.code;
  return (
    code === "NOT_FOUND" || code === "FORBIDDEN" || code === "UNAUTHORIZED"
  );
}

type RenameErrorShape = {
  data?: {
    field?: string | null;
    zodError?: { fieldErrors?: Record<string, string[]> } | null;
  } | null;
};

const TITLE_LIMIT_MESSAGE = "Titles are limited to 200 characters.";

/**
 * The service's own 200-char cap surfaces as `data.field === "title"`
 * (a field-pinned BAD_REQUEST). A title over the transport schema's 400-char
 * cap (renameConversationInput) never reaches the service at all — it fails
 * Zod validation first, where the field name is only reachable via
 * `data.zodError.fieldErrors`, not `data.field`. Both are the same
 * user-facing problem ("your title is too long"), so both map to the same
 * message here instead of leaking Zod's wording for the second one.
 */
export function renameTitleFieldError(err: RenameErrorShape): string | null {
  if (err.data?.field === "title") return TITLE_LIMIT_MESSAGE;
  if (err.data?.zodError?.fieldErrors?.title?.length)
    return TITLE_LIMIT_MESSAGE;
  return null;
}
