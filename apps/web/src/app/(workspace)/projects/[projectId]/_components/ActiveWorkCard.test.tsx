import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActiveWorkCard } from "./ActiveWorkCard";

describe("ActiveWorkCard", () => {
  it("keeps the authorized audience in its history link", () => {
    const html = renderToStaticMarkup(
      <ActiveWorkCard
        projectId="p1"
        audience="mine"
        items={[]}
        loading={false}
        error={null}
        retry={() => undefined}
      />,
    );
    expect(html).toContain('aria-label="Active work"');
    expect(html).toContain(
      "/account/background-work?audience=mine&amp;projectId=p1",
    );
    expect(html).toContain("No active work");
    expect(html).not.toContain("Mark");
  });
  it("labels stale results without exposing server error text", () => {
    const html = renderToStaticMarkup(
      <ActiveWorkCard
        projectId="p1"
        audience="projects"
        items={[]}
        loading={false}
        error={new Error("secret")}
        retry={() => undefined}
      />,
    );
    expect(html).toContain("out of date");
    expect(html).toContain("Retry");
    expect(html).not.toContain("secret");
  });
});
