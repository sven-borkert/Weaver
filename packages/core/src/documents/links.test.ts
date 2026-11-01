import { describe, expect, it } from "vitest";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { extractCrossrefTargets, type CrossrefTarget } from "./links";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TABLE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("extractCrossrefTargets", () => {
  it("finds targets nested inside callouts, lists, and tables", () => {
    const md = `[top](weaver://document/${A})

> [!NOTE]
> nested [in callout](weaver://document/${B})

- list item with [dup](weaver://document/${A})

| c |
| --- |
| [in table](weaver://document/${B}) |
`;
    const expected: CrossrefTarget[] = [
      { targetType: "document", targetId: A },
      { targetType: "document", targetId: B },
    ];
    expect(extractCrossrefTargets(parseDocumentBody(md))).toEqual(expected);
  });
  it("returns empty for content without crossrefs", () => {
    expect(extractCrossrefTargets(parseDocumentBody("plain **text**"))).toEqual(
      [],
    );
  });
  it("skips malformed targetIds defensively", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "crossref", attrs: { targetId: "not-a-uuid", label: null } },
      ],
    };
    expect(extractCrossrefTargets(doc)).toEqual([]);
  });

  it("extracts typed targets, defaulting legacy refs to document", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "crossref", attrs: { targetId: A } },
            {
              type: "crossref",
              attrs: { targetType: "table", targetId: TABLE_ID },
            },
          ],
        },
      ],
    };
    expect(extractCrossrefTargets(doc)).toEqual([
      { targetType: "document", targetId: A },
      { targetType: "table", targetId: TABLE_ID },
    ] satisfies CrossrefTarget[]);
  });
});
