import { describe, expect, it } from "vitest";
import { liveAnnouncement } from "./liveAnnouncement";

describe("liveAnnouncement", () => {
  it("announces once while a run is active, regardless of the last message", () => {
    expect(
      liveAnnouncement({
        activeRun: true,
        lastMessage: { role: "user", status: "pending", text: "Go" },
      }),
    ).toBe("Assistant is replying");
    expect(liveAnnouncement({ activeRun: true, lastMessage: null })).toBe(
      "Assistant is replying",
    );
  });

  it("announces the final assistant text once the run settles", () => {
    expect(
      liveAnnouncement({
        activeRun: false,
        lastMessage: {
          role: "assistant",
          status: "complete",
          text: "**Hi** there",
        },
      }),
    ).toBe("**Hi** there");
  });

  it("falls back to a generic phrase for an empty completed message", () => {
    expect(
      liveAnnouncement({
        activeRun: false,
        lastMessage: { role: "assistant", status: "complete", text: "" },
      }),
    ).toBe("Assistant replied");
  });

  it("announces failure and cancellation distinctly, off the *user* message's status", () => {
    // A run's failure or cancellation updates the triggering user message's
    // status, not an assistant message (assistantRuns.ts never creates an
    // assistant row for either outcome) — so this is role "user" in reality,
    // not "assistant".
    expect(
      liveAnnouncement({
        activeRun: false,
        lastMessage: { role: "user", status: "failed", text: "Go" },
      }),
    ).toBe("The assistant couldn’t finish this answer.");
    expect(
      liveAnnouncement({
        activeRun: false,
        lastMessage: { role: "user", status: "cancelled", text: "Go" },
      }),
    ).toBe("The run was cancelled.");
  });

  it("stays silent when the last message is the user's own settled text, or there is none", () => {
    expect(
      liveAnnouncement({
        activeRun: false,
        lastMessage: { role: "user", status: "complete", text: "Hi" },
      }),
    ).toBe("");
    expect(liveAnnouncement({ activeRun: false, lastMessage: null })).toBe("");
  });
});
