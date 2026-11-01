import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DocumentOutlineList,
  DocumentOutlinePanel,
} from "./DocumentOutlinePanel";

const outline = [
  { anchor: "section-setup", level: 2, text: "Setup" },
  { anchor: "section-setup--install", level: 3, text: "Install" },
  { anchor: "section-usage", level: 2, text: "Usage" },
];

afterEach(() => vi.unstubAllGlobals());

describe("DocumentOutlineList", () => {
  it("indents entries below the shallowest level and marks the current one", () => {
    const html = renderToStaticMarkup(
      <DocumentOutlineList
        outline={outline}
        current="section-setup--install"
        navigable
        onSelect={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Table of contents"');
    const buttons = Array.from(html.matchAll(/<button[^>]*>([^<]*)</g));
    expect(buttons.map((match) => match[1])).toEqual([
      "Setup",
      "Install",
      "Usage",
    ]);
    expect(buttons[0]![0]).toContain("pl-2");
    expect(buttons[1]![0]).toContain("pl-5");
    expect(buttons[1]![0]).toContain('aria-current="location"');
    expect(buttons[0]![0]).not.toContain("aria-current");
    expect(buttons[1]![0]).toContain('title="Install"');
  });

  it("jumps to the chosen section", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onSelect = vi.fn();
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <DocumentOutlineList outline={outline} navigable onSelect={onSelect} />,
      );
    });
    await act(async () => {
      const button = renderer.root.findAllByType("button")[2]!;
      (button.props as { onClick: () => void }).onClick();
    });
    expect(onSelect).toHaveBeenCalledWith("section-usage");
  });

  it("disables jumping while comparing versions", () => {
    const html = renderToStaticMarkup(
      <DocumentOutlineList
        outline={outline}
        navigable={false}
        onSelect={() => undefined}
      />,
    );

    expect(html).toContain("Return to the document to jump to a section.");
    expect(html.match(/<button[^>]* disabled=""/g)).toHaveLength(3);
  });

  it("explains an outline without headings", () => {
    const html = renderToStaticMarkup(
      <DocumentOutlineList outline={[]} navigable onSelect={() => undefined} />,
    );

    expect(html).toContain("This document has no headings.");
    expect(html).not.toContain("<nav");
  });
});

describe("DocumentOutlinePanel", () => {
  it("lists the saved headings without a live editor", () => {
    const html = renderToStaticMarkup(
      <DocumentOutlinePanel
        editor={null}
        contentJson={{
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 1 },
              content: [{ type: "text", text: "Overview" }],
            },
          ],
        }}
        active={false}
        navigable
        onSelect={() => undefined}
      />,
    );

    expect(html).toContain(">Overview</button>");
  });
});
