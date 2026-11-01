import { describe, expect, it } from "vitest";
import { buildTaskPrompt, TASK_SYSTEM_PROMPT } from "./taskPrompt";

describe("task prompt", () => {
  it("names the mechanism the e2e mock keys on and forbids invention", () => {
    expect(TASK_SYSTEM_PROMPT).toContain("scheduled task");
    expect(TASK_SYSTEM_PROMPT).toMatch(/do not invent/i);
  });

  it("orders instruction, period, digest, then content and flags truncation", () => {
    const prompt = buildTaskPrompt({
      taskName: "Digest",
      instruction: "Summarize the changes.",
      digest: "## Changes in Ops\n- something",
      content: "## Document: Runbook\nrestart nginx",
      period: {
        from: new Date("2026-09-01T00:00:00Z"),
        to: new Date("2026-09-08T00:00:00Z"),
      },
      truncated: true,
    });
    expect(prompt.indexOf("Summarize the changes.")).toBeLessThan(
      prompt.indexOf("## Changes in Ops"),
    );
    expect(prompt.indexOf("## Changes in Ops")).toBeLessThan(
      prompt.indexOf("## Document: Runbook"),
    );
    expect(prompt).toContain("2026-09-01");
    expect(prompt).toContain("2026-09-08");
    expect(prompt).toMatch(/truncated/i);
    expect(
      buildTaskPrompt({
        taskName: "D",
        instruction: "x",
        digest: "",
        content: "",
        period: { from: null, to: new Date() },
        truncated: false,
      }),
    ).not.toMatch(/truncated/i);
  });
});

it("appends framed external inputs without unbudgeted separators", () => {
  const input = {
    taskName: "Report",
    instruction: "Summarize",
    digest: "Changes",
    content: "Content",
    period: { from: null, to: new Date("2026-09-09T00:00:00.000Z") },
    truncated: false,
  };
  const externalBlocks = [
    "\n<external-input>漢字</external-input>\n",
    "\n<external-input>😀</external-input>\n",
  ];
  const base = buildTaskPrompt(input);
  expect(buildTaskPrompt({ ...input, externalBlocks }).slice(base.length)).toBe(
    externalBlocks.join(""),
  );
});
