export type LiveAnnouncementMessage = {
  role: "user" | "assistant";
  status: "pending" | "complete" | "failed" | "cancelled";
  text: string;
};

export type LiveAnnouncementInput = {
  activeRun: boolean;
  lastMessage: LiveAnnouncementMessage | null;
};

/**
 * Spec §10.1: a single polite live region announces "Assistant is replying"
 * once and the final message once — not one announcement per delta. Screen
 * readers announce a live region on content *change*, so the fix isn't an
 * effect that fires on every event: it's deriving a value that only takes on
 * a new string at the two meaningful moments (run starts, run settles) and
 * otherwise holds steady through every intermediate re-render.
 */
export function liveAnnouncement({
  activeRun,
  lastMessage,
}: LiveAnnouncementInput): string {
  if (activeRun) return "Assistant is replying";
  if (!lastMessage) return "";
  switch (lastMessage.status) {
    case "complete":
      // A completed *user* message just means the conversation moved on —
      // the assistant's own reply (a separate, later message) is what's
      // worth announcing. Only the assistant's completed text counts here.
      return lastMessage.role === "assistant"
        ? lastMessage.text || "Assistant replied"
        : "";
    case "failed":
      // Failure/cancellation land on the *user* message's status — a run
      // never produces an assistant row for either outcome (assistantRuns.ts
      // only ever creates one with status "complete") — so this branch is
      // reached with `lastMessage.role === "user"` in practice, not
      // "assistant". Announce it regardless of role: a terminal error is
      // worth surfacing wherever the backend happened to record it.
      return "The assistant couldn’t finish this answer.";
    case "cancelled":
      return "The run was cancelled.";
    case "pending":
      return "";
  }
}
