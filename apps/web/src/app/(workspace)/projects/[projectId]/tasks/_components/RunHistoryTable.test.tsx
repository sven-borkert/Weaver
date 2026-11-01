import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunHistoryTable } from "./RunHistoryTable";

describe("RunHistoryTable", () => {
  it("shows status, trigger, duration, tokens, the commit link, and the error", () => {
    const html = renderToStaticMarkup(
      <RunHistoryTable
        runs={[
          {
            id: "r1",
            status: "succeeded",
            trigger: "schedule",
            queuedAt: new Date("2026-09-08T05:00:00Z"),
            startedAt: new Date("2026-09-08T05:00:01Z"),
            finishedAt: new Date("2026-09-08T05:00:21Z"),
            durationMs: 20000,
            inputTokens: 1200,
            outputTokens: 300,
            outputDocumentId: "d1",
            outputProjectId: "earlier-project",
            outputCommitSha: "a".repeat(40),
            errorCode: null,
            errorMessage: null,
            contextSummary: null,
          },
          {
            id: "r2",
            status: "failed",
            trigger: "manual",
            queuedAt: new Date("2026-09-08T06:00:00Z"),
            startedAt: null,
            finishedAt: null,
            durationMs: null,
            inputTokens: null,
            outputTokens: null,
            outputDocumentId: null,
            outputProjectId: null,
            outputCommitSha: null,
            errorCode: "ROUTE_MISSING",
            errorMessage: "no model is routed",
            contextSummary: null,
          },
        ]}
      />,
    );
    expect(html).toContain("Succeeded");
    expect(html).toContain("Scheduled");
    expect(html).toContain("20 s");
    expect(html).toContain("1,200");
    expect(html).toContain("aaaaaaa");
    // The run's own project and saved commit, not the task's current project.
    expect(html).toContain(
      `/projects/earlier-project/documents/d1?version=${"a".repeat(40)}`,
    );
    expect(html).toContain("ROUTE_MISSING");
    expect(html).toContain("no model is routed");
  });

  it("shows the commit without a link when the run's project is not readable", () => {
    const html = renderToStaticMarkup(
      <RunHistoryTable
        runs={[
          {
            id: "r3",
            status: "succeeded",
            trigger: "schedule",
            queuedAt: new Date("2026-09-08T05:00:00Z"),
            startedAt: null,
            finishedAt: null,
            durationMs: null,
            inputTokens: null,
            outputTokens: null,
            outputDocumentId: "d1",
            outputProjectId: null,
            outputCommitSha: "b".repeat(40),
            errorCode: null,
            errorMessage: null,
            contextSummary: null,
          },
        ]}
      />,
    );
    expect(html).toContain("bbbbbbb");
    expect(html).not.toContain("/documents/d1");
  });
});
