import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ExternalSources } from "./ExternalSources";
it("keeps stored names and time without remote resources or invented links", () => {
  const html = renderToStaticMarkup(
    <ExternalSources
      sources={[
        {
          callId: "c",
          connectionId: "deleted",
          connectionName: "Old service",
          toolName: "<img src=https://remote.test>",
          retrievedAt: "2026-09-09T12:00:00Z",
          truncated: true,
        },
      ]}
    />,
  );
  expect(html).toContain("Old service");
  expect(html).toContain("2026-09-09T12:00:00Z");
  expect(html).toContain("Result truncated");
  expect(html).not.toMatch(/<a |<img /);
});
