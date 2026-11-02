import { describe, expect, it } from "vitest";
import { changeKindOf } from "./changeKinds";

describe("changeKindOf", () => {
  it.each([
    ["mcp:abc", "mcp"],
    ["proposal:1", "proposal"],
    ["task-run:1", "task-run"],
    ["ingestion:f", "ingestion"],
    ["project-api:k", "project-api"],
    ["exam:1", "exam"],
    ["wiki-run:r:0001", "wiki-run"],
    ["wiki-bootstrap:p:0001", "wiki-bootstrap"],
    ["wiki-input:i", "wiki-input"],
    ["wiki-revert:r:0001", "wiki-revert"],
    ["mystery:1", "external"],
    ["mcp", "external"],
    [null, "ui"],
  ])("maps a trusted %s to %s", (operationId, kind) => {
    expect(changeKindOf({ trustedAuthor: true, operationId })).toBe(kind);
  });
  it("reports untrusted commits as external whatever their trailer says", () => {
    for (const trustedAuthor of [false, undefined])
      expect(changeKindOf({ trustedAuthor, operationId: "wiki-run:r:1" })).toBe(
        "external",
      );
    expect(changeKindOf({ trustedAuthor: false, operationId: null })).toBe(
      "external",
    );
  });
});
