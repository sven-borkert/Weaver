import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "~/components/ui/tooltip";
import { IndexLights } from "./IndexLights";

function render(lights: Parameters<typeof IndexLights>[0]["lights"]) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <IndexLights lights={lights} />
    </TooltipProvider>,
  );
}

describe("IndexLights", () => {
  it("labels the group and colours ready/failed/pending distinctly", () => {
    const html = render({
      keyword: "ready",
      semantic: "failed",
      graph: "pending",
      summary: "Provider unavailable",
    });
    expect(html).toContain(
      'aria-label="Index: keyword ready, semantic failed, graph pending. Provider unavailable"',
    );
    expect(html).toContain('data-light="ready"');
    expect(html).toContain('data-light="failed"');
    expect(html).toContain('data-light="pending"');
    expect(html).toContain("bg-approved-dot");
    expect(html).toContain("bg-danger");
  });

  it("renders unavailable as a hollow dot", () => {
    const html = render({
      keyword: "pending",
      semantic: "unavailable",
      graph: "unavailable",
      summary: null,
    });
    expect(html).toContain('data-light="unavailable"');
    expect(html).not.toContain("bg-approved-dot");
  });
});
