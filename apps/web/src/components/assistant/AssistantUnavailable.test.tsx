import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantUnavailable } from "./AssistantUnavailable";

describe("AssistantUnavailable", () => {
  it("shows an admin link to /admin/settings/ai for no_route when the viewer is an Admin", () => {
    const html = renderToStaticMarkup(
      <AssistantUnavailable reason="no_route" isAdmin />,
    );
    expect(html).toContain("The assistant isn");
    expect(html).toContain("set up yet");
    expect(html).toMatch(/<a[^>]*href="\/admin\/settings\/ai"[^>]*>/);
    expect(html).toContain("Configure an assistant model");
    expect(html).not.toContain("Ask an administrator");
  });

  it("hides the admin link for no_route when the viewer is not an Admin", () => {
    const html = renderToStaticMarkup(
      <AssistantUnavailable reason="no_route" isAdmin={false} />,
    );
    expect(html).toContain("set up yet");
    expect(html).not.toMatch(/<a[^>]*href="\/admin\/settings\/ai"[^>]*>/);
    expect(html).toContain("Ask an administrator to configure it.");
  });

  it("shows the jobs_disabled message with no admin link, even for an Admin", () => {
    const html = renderToStaticMarkup(
      <AssistantUnavailable reason="jobs_disabled" isAdmin />,
    );
    expect(html).toContain("The assistant is unavailable right now");
    expect(html).not.toMatch(/<a[^>]*href="\/admin\/settings\/ai"[^>]*>/);
    expect(html).toContain("Ask an administrator to configure it.");
  });
});
