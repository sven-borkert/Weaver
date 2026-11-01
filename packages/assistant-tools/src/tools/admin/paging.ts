import { ADMIN_LIST_MAX } from "@weaver/core/services/adminPaging";
import { z } from "zod";

import {
  MAX_TOOL_OUTPUT_CHARS,
  ToolError,
  boundItems,
  newOutputBudget,
  utf8Bytes,
} from "../../contract";

export const listInput = {
  limit: z.number().int().min(1).max(ADMIN_LIST_MAX).optional(),
  cursor: z.string().max(600).optional(),
};

export const isoDate = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value));

export function pagedOutput<T>(
  page: {
    items: readonly T[];
    nextCursor: string | null;
    truncated?: boolean;
  },
  cursorFor: (item: T) => string,
): { items: T[]; nextCursor: string | null; truncated: boolean } {
  const items: T[] = [];

  for (const item of page.items) {
    const candidateItems = [...items, item];
    const hasRemaining = candidateItems.length < page.items.length;
    const nextCursor = hasRemaining ? cursorFor(item) : page.nextCursor;
    const truncated = Boolean(page.truncated) || hasRemaining;
    const emptyEnvelopeLength = utf8Bytes(
      JSON.stringify({
        items: [],
        nextCursor,
        truncated,
      }),
    );
    const bounded = boundItems(
      candidateItems,
      newOutputBudget(MAX_TOOL_OUTPUT_CHARS - emptyEnvelopeLength + 1),
    );

    if (bounded.items.length !== candidateItems.length) break;
    items.push(item);
  }

  if (page.items.length > 0 && items.length === 0) {
    throw new ToolError("INTERNAL", "page item exceeds tool output limit");
  }

  const outputTruncated = items.length < page.items.length;
  const last = items.at(-1);
  const result = {
    items,
    nextCursor: outputTruncated && last ? cursorFor(last) : page.nextCursor,
    truncated: Boolean(page.truncated) || outputTruncated,
  };
  if (utf8Bytes(JSON.stringify(result)) > MAX_TOOL_OUTPUT_CHARS) {
    throw new ToolError("INTERNAL", "page output exceeds tool output limit");
  }
  return result;
}
