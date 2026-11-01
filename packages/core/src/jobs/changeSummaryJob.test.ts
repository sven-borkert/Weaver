import { describe, expect, it } from "vitest";
import { validKnowledgeJobPayload } from "./knowledgePayloads";
import { KNOWLEDGE_JOB_NAMES, knowledgeJobSendOptions } from "./types";

const payload = {
  projectId: "11111111-1111-4111-8111-111111111111",
  documentId: "22222222-2222-4222-8222-222222222222",
  commitSha: "b".repeat(40),
  baseCommitSha: "a".repeat(40),
  pathAtSha: "notes/doc.md",
};

describe("document.change-summary job contract", () => {
  it("is a registered job deduplicated per project commit", () => {
    expect(KNOWLEDGE_JOB_NAMES).toContain("document.change-summary");
    expect(knowledgeJobSendOptions("document.change-summary", payload)).toEqual(
      { singletonKey: `${payload.projectId}:${payload.commitSha}` },
    );
  });

  it("validates the payload strictly", () => {
    expect(validKnowledgeJobPayload("document.change-summary", payload)).toBe(
      true,
    );
    expect(
      validKnowledgeJobPayload("document.change-summary", {
        ...payload,
        commitSha: "HEAD",
      }),
    ).toBe(false);
    expect(
      validKnowledgeJobPayload("document.change-summary", {
        ...payload,
        extra: true,
      }),
    ).toBe(false);
  });
});
