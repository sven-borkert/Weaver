import { describe, expect, it } from "vitest";
import { MCP_TOOLSET_NAMES } from "@weaver/assistant-tools/toolsetNames";
import { MAX_INSTRUCTIONS_CHARS, buildMcpInstructions } from "./instructions";

describe("buildMcpInstructions", () => {
  it("starts with what Weaver is and stays under the client truncation limit with every sentence present", () => {
    const all = MCP_TOOLSET_NAMES.filter((n) => n !== "all");
    const text = buildMcpInstructions({
      activeToolsets: all,
      availableToolsets: [],
      exams: true,
      admin: true,
      external: true,
    });
    expect(
      text.startsWith("Weaver is the user's personal knowledge platform."),
    ).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
    expect(text).toContain("X-Weaver-Toolsets");
    expect(text).toContain("grade_exam_attempt");
    expect(text).toContain("Admin tools read internal state");
    expect(text).toContain("ext_<connection>__<tool>");
    expect(text).toContain("every toolset is active");
  });

  it("names active and available toolsets and omits the optional sentences", () => {
    const text = buildMcpInstructions({
      activeToolsets: ["core", "write"],
      availableToolsets: ["documents", "tables"],
      admin: false,
      external: false,
    });
    expect(text).toContain(
      "toolsets core, write; also available: documents, tables.",
    );
    expect(text).not.toContain("Admin tools");
    expect(text).not.toContain("grade_exam_attempt");
    expect(text).not.toContain("ext_<connection>");
    expect(
      text.endsWith(
        "Resources use weaver://projects/{projectId}/documents|tables|entities/{id}.",
      ),
    ).toBe(true);
  });
});
