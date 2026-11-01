import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ClientDate } from "./ConnectedAppsCard";

describe("ClientDate", () => {
  it("renders a locale-neutral placeholder during server rendering", () => {
    const markup = renderToStaticMarkup(
      <ClientDate value={new Date("2026-09-04T12:34:56.000Z")} />,
    );

    expect(markup).toContain('aria-label="Date loading"');
    expect(markup).not.toContain("2026");
    expect(markup).not.toContain("<time");
  });
});
