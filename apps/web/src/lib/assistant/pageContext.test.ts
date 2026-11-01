import { describe, expect, it } from "vitest";
import { pageContextFromPath } from "./pageContext";

const P = "11111111-1111-4111-8111-111111111111";
const D = "33333333-3333-4333-8333-333333333333";

describe("pageContextFromPath", () => {
  it("extracts project, document and table ids from workspace routes", () => {
    expect(pageContextFromPath(`/projects/${P}/documents/${D}`)).toEqual({
      projectId: P,
      documentId: D,
    });
    expect(pageContextFromPath(`/projects/${P}/tables/${D}`)).toEqual({
      projectId: P,
      tableId: D,
    });
    expect(pageContextFromPath(`/projects/${P}/graph`)).toEqual({
      projectId: P,
    });
    expect(pageContextFromPath(`/projects/${P}/settings`)).toEqual({
      projectId: P,
    });
  });
  it("returns nothing for non-project routes and rejects non-uuid segments", () => {
    expect(pageContextFromPath("/")).toEqual({});
    expect(pageContextFromPath("/assistant/abc")).toEqual({});
    expect(pageContextFromPath("/projects/not-a-uuid/documents/x")).toEqual({});
  });
});
