export function hasPersistedRunOutcome(
  runId: string,
  messages: ReadonlyArray<{
    runId: string | null;
    role: string;
    status: string;
  }>,
): boolean {
  return messages.some(
    (message) =>
      message.runId === runId &&
      ((message.role === "assistant" && message.status === "complete") ||
        (message.role === "user" &&
          ["failed", "cancelled"].includes(message.status))),
  );
}
