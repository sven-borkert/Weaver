import { describe, expect, it } from "vitest";
import {
  activityKey,
  dashboardDestinationHref,
  activityAttribution,
  workOutcomeLabel,
} from "./presentation";

describe("dashboard presentation", () => {
  it("keys entries by source and id", () => {
    expect(activityKey({ source: "document", id: "same" })).toBe(
      "document:same",
    );
    expect(activityKey({ source: "task", id: "same" })).toBe("task:same");
  });

  it("builds encoded links from typed destinations only", () => {
    expect(
      dashboardDestinationHref({
        kind: "document",
        projectId: "p/a",
        documentId: "d?1",
      }),
    ).toBe("/projects/p%2Fa/documents/d%3F1");
    expect(
      dashboardDestinationHref({ kind: "assistant", conversationId: "c/x" }),
    ).toBe("/assistant/c%2Fx");
    expect(
      dashboardDestinationHref({ kind: "knowledge", projectId: "p/a" }),
    ).toBe("/projects/p%2Fa/graph");
  });

  it("does not invent missing attribution", () => {
    expect(activityAttribution(null, false)).toBe("Updated");
    expect(activityAttribution("Ada", false)).toBe("Updated by Ada");
    expect(activityAttribution("Ada", true)).toBe("Updated by you");
  });

  it("uses useful terminal work outcome labels", () => {
    expect(workOutcomeLabel("succeeded")).toBe("Completed");
    expect(workOutcomeLabel("failed")).toBe("Failed");
    expect(workOutcomeLabel("cancelled")).toBe("Cancelled");
  });
});

it("links exam results to the personal attempt", () => {
  expect(
    dashboardDestinationHref({
      kind: "exam",
      projectId: "p1",
      attemptId: "a1",
    }),
  ).toBe("/projects/p1/exams/attempts/a1");
});
