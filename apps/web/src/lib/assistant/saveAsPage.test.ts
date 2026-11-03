import { describe, expect, it } from "vitest";
import {
  buildSaveAsPagePrefill,
  parseFolderInput,
  savePropertiesFor,
  sourcesFromCitations,
  titleFromAnswer,
} from "./saveAsPage";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const card = (
  resourceId: string,
  projectId: string,
  extra: Record<string, unknown> = {},
) => ({
  kind: "document" as const,
  projectId,
  resourceId,
  access: "ok" as const,
  label: `Doc ${resourceId.slice(0, 2)}`,
  ...extra,
});

describe("titleFromAnswer", () => {
  it("takes the first heading or line as plain text and bounds it", () => {
    expect(titleFromAnswer("\n## The **Answer** [here](https://x)\nbody")).toBe(
      "The Answer here",
    );
    expect(titleFromAnswer("- first item\nsecond")).toBe("first item");
    expect(titleFromAnswer("x".repeat(500))).toHaveLength(200);
    expect(titleFromAnswer("   \n  ")).toBe("Assistant answer");
  });
});

describe("sourcesFromCitations", () => {
  it("checks citations of the target project and lists the others unchecked with a warning", () => {
    const sources = sourcesFromCitations(
      [
        card(A, "p1"),
        card(B, "p2"),
        card(A, "p1"),
        { ...card("33", "p1"), kind: "graph" as const },
        { ...card("44", "p1"), kind: "search" as const },
        card("55", "p1", { access: "unavailable" }),
        { ...card("66", "p1"), kind: "table" as const },
      ],
      "p1",
    );
    expect(sources.map((s) => [s.kind, s.id, s.checked])).toEqual([
      ["document", A, true],
      ["document", B, false],
      ["table", "66", true],
    ]);
    expect(sources[0]!.warning).toBeNull();
    expect(sources[1]).toMatchObject({
      inTargetProject: false,
    });
    expect(sources[1]!.warning).toMatch(/another project/);
  });
});

describe("buildSaveAsPagePrefill", () => {
  it("maps an answer to a synthesis page under the wiki anchor", () => {
    const prefill = buildSaveAsPagePrefill({
      answerText: "# Findings\n\nText [1].",
      citations: [card(A, "p1"), card(B, "p2")],
      targetProjectId: "p1",
      wikiFolderPath: ["wiki"],
    });
    expect(prefill).toMatchObject({
      title: "Findings",
      folderPath: ["wiki"],
      body: "# Findings\n\nText [1].",
      type: "synthesis",
    });
    expect(prefill.sources.map((s) => s.checked)).toEqual([true, false]);
  });

  it("has no folder default without a wiki", () => {
    expect(
      buildSaveAsPagePrefill({
        answerText: "Hi",
        citations: [],
        targetProjectId: "p1",
        wikiFolderPath: null,
      }).folderPath,
    ).toEqual([]);
  });
});

describe("savePropertiesFor", () => {
  it("sends only checked sources of the target project", () => {
    const sources = sourcesFromCitations([card(A, "p1"), card(B, "p2")], "p1");
    expect(savePropertiesFor("synthesis", sources)).toEqual({
      type: "synthesis",
      sources: [{ kind: "document", id: A }],
    });
    sources[0]!.checked = false;
    sources[1]!.checked = true;
    expect(savePropertiesFor("synthesis", sources)).toEqual({
      type: "synthesis",
    });
  });
});

describe("parseFolderInput", () => {
  it("splits on slashes and drops empty segments", () => {
    expect(parseFolderInput(" wiki / notes//")).toEqual(["wiki", "notes"]);
    expect(parseFolderInput("")).toEqual([]);
  });
});
