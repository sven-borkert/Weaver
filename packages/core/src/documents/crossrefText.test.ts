import { describe, expect, it } from "vitest";
import {
  crossrefTargetKey,
  parseDocumentBody,
  serializeDocumentBody,
} from "../editor/markdown";
import { crossrefsToText } from "./crossrefText";

const id = "6f1f39d4-3f6a-4b7e-9a80-0a4c3a3f1b2c";

describe("crossrefsToText", () => {
  it("replaces references with the current title, else the stored label", () => {
    const json = parseDocumentBody(
      `See [Old](weaver://document/${id}) and [Gone](weaver://table/${id}).\n`,
    );
    const out = crossrefsToText(
      json,
      new Map([[crossrefTargetKey("document", id), "New title"]]),
    );
    expect(serializeDocumentBody(out)).toBe("See New title and Gone.\n");
    expect(JSON.stringify(out)).not.toContain("crossref");
  });
});
