import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { toMessageView } from "../services/assistantConversations";
import type { AssistantMessage } from "@weaver/db/client";
import type { ScopeSnapshot } from "../assistant/scopeSchema";
import { assertExternalHistoryScope } from "./historyScope";
const projectId = randomUUID();
const scope: ScopeSnapshot = {
  kind: "project",
  projectIds: [projectId],
  documentId: null,
  tableId: null,
  resolvedAt: new Date().toISOString(),
  truncated: false,
};
function message(
  role: "user" | "assistant",
  content: AssistantMessage["content"],
  storedScope: AssistantMessage["scopeSnapshot"] = scope,
) {
  return toMessageView({
    id: randomUUID(),
    conversationId: randomUUID(),
    position: 0,
    role,
    status: "complete",
    content,
    scopeSnapshot: storedScope,
    createdAt: new Date(),
  });
}
it("derives user lineage only from valid scope and requires persisted assistant lineage", () => {
  expect(message("user", { text: "hello" }).contextProjectIds).toEqual([
    projectId,
  ]);
  expect(
    message("user", { contextProjectIds: [projectId] }, null).contextProjectIds,
  ).toBeNull();
  expect(message("assistant", { text: "legacy" }).contextProjectIds).toBeNull();
  expect(
    message("assistant", { contextProjectIds: [projectId] }).contextProjectIds,
  ).toEqual([projectId]);
});
it("rejects unknown, malformed, overflow and cross-project replay with fresh-conversation guidance", () => {
  for (const lineage of [
    undefined,
    null,
    [123],
    ["bad-id"],
    Array.from({ length: 101 }, () => randomUUID()),
    [randomUUID()],
  ]) {
    const history = [
      message(
        "assistant",
        lineage === undefined ? {} : { contextProjectIds: lineage },
      ),
    ];
    expect(() => assertExternalHistoryScope(history, scope)).toThrow(
      /fresh conversation/i,
    );
  }
  expect(() =>
    assertExternalHistoryScope(
      [
        message("user", {}),
        message("assistant", { contextProjectIds: [projectId] }),
      ],
      scope,
    ),
  ).not.toThrow();
});
it("carries all replayed lineage into later answers and keeps unknown lineage unknown", async () => {
  const { mergeContextProjectIds } = await import("./historyScope");
  const other = randomUUID();
  expect(
    mergeContextProjectIds(
      [message("assistant", { contextProjectIds: [other, projectId] })],
      scope,
    ),
  ).toEqual([projectId, other]);
  expect(mergeContextProjectIds([message("assistant", {})], scope)).toBeNull();
  expect(
    mergeContextProjectIds(
      [
        message("assistant", {
          contextProjectIds: Array.from({ length: 100 }, () => randomUUID()),
        }),
      ],
      scope,
    ),
  ).toBeNull();
});
