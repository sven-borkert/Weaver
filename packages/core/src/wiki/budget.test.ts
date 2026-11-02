import { describe, expect, it } from "vitest";
import { compileDocumentPatch } from "../documents/patch";
import {
  checkBudget,
  checkNonOwnedActions,
  formatWikiOperationId,
  MAX_WIKI_OPERATION_N,
  measureCreate,
  measurePatch,
} from "./budget";

const body = "# Title\n\nOne two three.\n\n## Part\n\nFour five six.\n";

describe("measurePatch", () => {
  it("counts a same-length replacement as gross", () => {
    const edits = compileDocumentPatch(
      body,
      [{ action: "replace_text", find: "two", replace: "TWO" }],
      "markdown",
    );
    expect(measurePatch(edits)).toEqual({
      grossCharsChanged: 3,
      charsAdded: 3,
    });
  });

  it("counts inserts as added only", () => {
    const edits = compileDocumentPatch(
      body,
      [
        { action: "insert_after", anchor: "three.", text: " more" },
        { action: "append", text: "tail" },
      ],
      "markdown",
    );
    expect(measurePatch(edits)).toEqual({
      grossCharsChanged: 0,
      charsAdded: 9,
    });
  });

  it("counts a removed section's pre-existing characters", () => {
    const sections = compileDocumentPatch(
      body,
      [{ action: "replace_text", find: "Four five six.", replace: "" }],
      "markdown",
    );
    expect(measurePatch(sections)).toEqual({
      grossCharsChanged: 14,
      charsAdded: 0,
    });
  });
});

describe("measureCreate", () => {
  it("counts the page as added", () => {
    expect(measureCreate("12345")).toEqual({
      grossCharsChanged: 0,
      charsAdded: 5,
    });
  });
});

describe("checkNonOwnedActions", () => {
  it("refuses section removal and replacement", () => {
    expect(
      checkNonOwnedActions([{ action: "remove_section", sectionId: "s" }]),
    ).toMatchObject({ allowed: false, code: "SECTION_ACTION_NOT_OWNED" });
    expect(
      checkNonOwnedActions([
        { action: "replace_section_body", sectionId: "s", text: "x" },
      ]),
    ).toMatchObject({ allowed: false, code: "SECTION_ACTION_NOT_OWNED" });
  });

  it("limits find and expectedMatches", () => {
    expect(
      checkNonOwnedActions([
        { action: "replace_text", find: "x".repeat(501), replace: "" },
      ]),
    ).toMatchObject({ allowed: false, code: "FIND_TOO_LONG" });
    expect(
      checkNonOwnedActions([
        { action: "replace_text", find: "x", replace: "", expectedMatches: 2 },
      ]),
    ).toMatchObject({ allowed: false, code: "EXPECTED_MATCHES" });
    expect(
      checkNonOwnedActions([
        { action: "replace_text", find: "x".repeat(500), replace: "" },
        { action: "append", text: "y" },
      ]),
    ).toEqual({ allowed: true });
  });
});

describe("checkBudget", () => {
  const zero = { grossCharsChanged: 0, charsAdded: 0 };

  it("never limits an owned page", () => {
    expect(
      checkBudget({
        owned: true,
        page: zero,
        run: zero,
        delta: { grossCharsChanged: 1_000_000, charsAdded: 1_000_000 },
      }),
    ).toEqual({ allowed: true });
  });

  it("allows exactly the per-page limits and refuses one more", () => {
    expect(
      checkBudget({
        owned: false,
        page: { grossCharsChanged: 1_999, charsAdded: 9_999 },
        run: zero,
        delta: { grossCharsChanged: 1, charsAdded: 1 },
      }),
    ).toEqual({ allowed: true });
    expect(
      checkBudget({
        owned: false,
        page: { grossCharsChanged: 2_000, charsAdded: 0 },
        run: zero,
        delta: { grossCharsChanged: 1, charsAdded: 0 },
      }),
    ).toMatchObject({ allowed: false, code: "PAGE_GROSS_BUDGET" });
    expect(
      checkBudget({
        owned: false,
        page: { grossCharsChanged: 0, charsAdded: 10_000 },
        run: zero,
        delta: { grossCharsChanged: 0, charsAdded: 1 },
      }),
    ).toMatchObject({ allowed: false, code: "PAGE_ADDED_BUDGET" });
  });

  it("limits the run across non-owned pages", () => {
    expect(
      checkBudget({
        owned: false,
        page: zero,
        run: { grossCharsChanged: 20_000, charsAdded: 0 },
        delta: { grossCharsChanged: 1, charsAdded: 0 },
      }),
    ).toMatchObject({ allowed: false, code: "RUN_GROSS_BUDGET" });
    expect(
      checkBudget({
        owned: false,
        page: zero,
        run: { grossCharsChanged: 0, charsAdded: 50_000 },
        delta: { grossCharsChanged: 0, charsAdded: 1 },
      }),
    ).toMatchObject({ allowed: false, code: "RUN_ADDED_BUDGET" });
  });
});

describe("formatWikiOperationId", () => {
  const RUN = "11111111-1111-4111-8111-111111111111";

  it("is fixed width", () => {
    expect(formatWikiOperationId("wiki-run", RUN, 7)).toBe(
      `wiki-run:${RUN}:0007`,
    );
    expect(formatWikiOperationId("wiki-revert", RUN, 9_999)).toBe(
      `wiki-revert:${RUN}:9999`,
    );
  });

  it("asserts the counter stays within four digits", () => {
    expect(MAX_WIKI_OPERATION_N).toBe(9_999);
    expect(() => formatWikiOperationId("wiki-run", RUN, 10_000)).toThrow();
    expect(() => formatWikiOperationId("wiki-run", RUN, 0)).toThrow();
  });
});
