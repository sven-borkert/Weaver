import { describe, expect, it } from "vitest";
import {
  createDocumentInput,
  resolveRefsInput,
  updateDocumentInput,
} from "./document";

const projectId = "00000000-0000-4000-8000-000000000000";

function referenceIds(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) =>
      `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
  );
}

describe("resolveRefsInput", () => {
  it("accepts 201 ids in one request", () => {
    expect(
      resolveRefsInput.safeParse({ projectId, ids: referenceIds(201) }).success,
    ).toBe(true);
  });

  it("accepts the 25,000-id safe ceiling", () => {
    expect(
      resolveRefsInput.safeParse({ projectId, ids: referenceIds(25_000) })
        .success,
    ).toBe(true);
  });

  it("rejects batches above the 25,000-id safe ceiling", () => {
    expect(
      resolveRefsInput.safeParse({ projectId, ids: referenceIds(25_001) })
        .success,
    ).toBe(false);
  });
});

describe("updateDocumentInput changeSummary", () => {
  const validInput = {
    projectId,
    documentId: "00000000-0000-4000-8000-000000000001",
    baseCommitSha: "a".repeat(40),
    content: { kind: "markdown", contentJson: { type: "doc", content: [] } },
  };

  it("reports the validator's own reason for invalid content", () => {
    const result = updateDocumentInput.safeParse({
      ...validInput,
      content: {
        kind: "markdown",
        contentJson: {
          type: "doc",
          content: [
            {
              type: "table",
              content: [
                {
                  type: "tableRow",
                  content: [
                    {
                      type: "tableCell",
                      attrs: { colspan: 2, rowspan: 1 },
                      content: [{ type: "paragraph" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    expect(result.success).toBe(false);
    expect(
      result.success ? [] : result.error.issues.map((issue) => issue.message),
    ).toEqual(["merged table cells are not supported"]);
  });

  it("accepts an omitted summary but rejects an explicitly empty one", () => {
    expect(updateDocumentInput.safeParse(validInput).success).toBe(true);
    expect(
      updateDocumentInput.safeParse({ ...validInput, changeSummary: " " })
        .success,
    ).toBe(false);
  });

  it.each([
    "first line\nsecond line",
    "first line\rsecond line",
    "summary\n",
    "\rsummary",
  ])("rejects line breaks in %j", (changeSummary) => {
    expect(
      updateDocumentInput.safeParse({ ...validInput, changeSummary }).success,
    ).toBe(false);
  });

  it("accepts a trimmed single-line summary at the 120-character limit", () => {
    const result = updateDocumentInput.safeParse({
      ...validInput,
      changeSummary: `  ${"a".repeat(120)}  `,
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.changeSummary).toHaveLength(120);
  });
});

it.each(["Alpha\rBeta", "Alpha\nBeta"])(
  "rejects multiline document title %j",
  (title) => {
    expect(
      createDocumentInput.safeParse({
        projectId,
        folderPath: [],
        title,
        contentJson: { type: "doc", content: [] },
      }).success,
    ).toBe(false);
  },
);
