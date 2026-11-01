import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolActivity, toolActivityLabel } from "./ToolActivity";

describe("toolActivityLabel", () => {
  it("names each tool in plain words", () => {
    expect(
      toolActivityLabel({
        toolCallId: "a",
        toolName: "search_knowledge",
        input: { query: "deploy" },
        ok: null,
        summary: null,
      }),
    ).toBe("Searched knowledge for “deploy”");
    expect(
      toolActivityLabel({
        toolCallId: "a",
        toolName: "read_document",
        input: {},
        ok: true,
        summary: null,
      }),
    ).toBe("Read a document");
    expect(
      toolActivityLabel({
        toolCallId: "a",
        toolName: "propose_document_edit",
        input: {},
        ok: true,
        summary: null,
      }),
    ).toBe("Proposed a document edit");
    expect(
      toolActivityLabel({
        toolCallId: "a",
        toolName: "unknown_tool",
        input: {},
        ok: null,
        summary: null,
      }),
    ).toBe("Used unknown_tool");
  });
});

describe("ToolActivity", () => {
  it("collapses rows behind a count and marks failures", () => {
    const html = renderToStaticMarkup(
      <ToolActivity
        tools={[
          {
            toolCallId: "a",
            toolName: "read_document",
            input: {},
            ok: true,
            summary: "3 kB",
          },
          {
            toolCallId: "b",
            toolName: "get_table",
            input: {},
            ok: false,
            summary: "SCOPE_VIOLATION",
          },
        ]}
      />,
    );
    expect(html).toContain("Used 2 tools");
    expect(html).toContain("Read a document");
    expect(html).toContain("SCOPE_VIOLATION");
    expect(html).not.toMatch(/chain|reasoning/i);
  });
  it("renders nothing for an empty list", () => {
    expect(renderToStaticMarkup(<ToolActivity tools={[]} />)).toBe("");
  });
  it("keeps the row list collapsed by default via CSS, not by omitting it from markup", () => {
    // Radix's Collapsible only keeps content in static/SSR markup at all when
    // `forceMount` is set — but `forceMount` alone also defeats its own
    // `hidden` attribute (its `isOpen` becomes permanently true), so the
    // *actual* collapsing has to come from a `data-state`-driven class
    // instead. Assert both halves so a regression to either extreme (content
    // missing again, or content missing its hiding class) is caught.
    const html = renderToStaticMarkup(
      <ToolActivity
        tools={[
          {
            toolCallId: "a",
            toolName: "read_document",
            input: {},
            ok: true,
            summary: null,
          },
        ]}
      />,
    );
    const trigger = /<button[^>]*data-slot="collapsible-trigger"[^>]*>/.exec(
      html,
    )?.[0];
    expect(trigger).toContain('aria-expanded="false"');
    const content = /<div[^>]*data-slot="collapsible-content"[^>]*>/.exec(
      html,
    )?.[0];
    expect(content).toBeTruthy();
    expect(content).toContain('data-state="closed"');
    expect(content).toContain("data-[state=closed]:hidden");
  });
});
