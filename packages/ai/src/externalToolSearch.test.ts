import { describe, expect, it } from "vitest";
import {
  externalDefinitionBytes,
  externalSchemaReserve,
  rankExternalTools,
} from "./externalToolSearch";

const tool = (
  n: number,
  name: string,
  connection: string,
  description = "",
) => ({
  name: `ext_${String(n).padStart(32, "0")}`,
  tool: name,
  connection,
  description,
  effect: "read" as const,
});
const tools = [
  tool(1, "list_applications", "Design Hub", "Lists applications"),
  tool(2, "get_application", "Design Hub", "Reads one application"),
  tool(3, "list_issues", "Tracker", "Lists issues"),
];

describe("rankExternalTools", () => {
  it("ranks name matches above description matches and drops non-matches", () => {
    const result = rankExternalTools(tools, { query: "list applications" });
    expect(result.matches.map((t) => t.tool)).toEqual([
      "list_applications",
      "list_issues",
    ]);
    expect(result.total).toBe(2);
  });
  it("filters by a case-insensitive connection substring", () => {
    const result = rankExternalTools(tools, { connection: "design" });
    expect(result.matches.map((t) => t.tool)).toEqual([
      "get_application",
      "list_applications",
    ]);
  });
  it("ignores one-character terms", () => {
    expect(rankExternalTools(tools, { query: "x" }).total).toBe(3);
  });
  it("returns at most ten matches but the full total", () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      tool(i, `tool_${String(i).padStart(2, "0")}`, "Big", "match"),
    );
    const result = rankExternalTools(many, { query: "match" });
    expect(result.matches).toHaveLength(10);
    expect(result.total).toBe(15);
  });
});

it("reserves an eighth of the window up to 32 KiB", () => {
  expect(externalSchemaReserve(1_000_000)).toBe(32_768);
  expect(externalSchemaReserve(64_000)).toBe(8_000);
  expect(externalSchemaReserve(0)).toBe(0);
});

it("measures a definition in UTF-8 bytes", () => {
  expect(
    externalDefinitionBytes({
      name: "ext_a",
      description: "ä",
      inputSchema: {},
    }),
  ).toBe(
    Buffer.byteLength(
      JSON.stringify({ name: "ext_a", description: "ä", inputSchema: {} }),
    ),
  );
});
