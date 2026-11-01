import { z } from "zod";
import type { ScopeSnapshot } from "../assistant/scopeSchema";
import type { MessageView } from "../services/assistantConversations";
import { CoreError } from "../errors";

const lineageSchema = z.array(z.uuid()).max(100);
export function parseContextProjectIds(value: unknown): string[] | null {
  const parsed = lineageSchema.safeParse(value);
  return parsed.success ? [...new Set(parsed.data)] : null;
}
export function assertExternalHistoryScope(
  history: MessageView[],
  scope: ScopeSnapshot,
): void {
  const allowed = new Set(scope.projectIds);
  for (const message of history) {
    const ids = parseContextProjectIds(message.contextProjectIds);
    if (ids === null || ids.some((id) => !allowed.has(id)))
      throw new CoreError(
        "PRECONDITION_FAILED",
        "Start a fresh conversation before using external tools with this scope.",
        { reason: "EXTERNAL_HISTORY_SCOPE" },
      );
  }
}

export function mergeContextProjectIds(
  history: readonly MessageView[],
  scope: ScopeSnapshot,
): string[] | null {
  const ids = new Set(scope.projectIds);
  for (const message of history) {
    const lineage = parseContextProjectIds(message.contextProjectIds);
    if (lineage === null) return null;
    for (const id of lineage) ids.add(id);
  }
  return parseContextProjectIds([...ids]);
}
