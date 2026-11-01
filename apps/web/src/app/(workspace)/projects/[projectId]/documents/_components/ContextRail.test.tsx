import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { PanelWidthsContext } from "~/components/layout/PanelResizeHandle";
import { ContextRail } from "./ContextRail";

it("puts Contents first and opens it without a chosen tab", () => {
  const html = renderToStaticMarkup(
    <ContextRail
      collapsed={false}
      contents={<p>contents body</p>}
      links={<p>links body</p>}
      history={<p>history body</p>}
      index={<p>index body</p>}
    />,
  );

  const tabs = Array.from(
    html.matchAll(/<button[^>]*role="tab"[^>]*>([^<]*)</g),
    (match) => ({
      label: match[1],
      selected: match[0].includes('aria-selected="true"'),
    }),
  );
  expect(tabs).toEqual([
    { label: "Contents", selected: true },
    { label: "Links", selected: false },
    { label: "History", selected: false },
    { label: "Index", selected: false },
  ]);
  expect(html).toContain("contents body");
});

it("offers the width handle only while the rail is expanded", () => {
  const rail = (collapsed: boolean) =>
    renderToStaticMarkup(
      <PanelWidthsContext.Provider
        value={{
          widths: { sidebar: 278, contextRail: 320 },
          preview: () => undefined,
          commit: () => undefined,
        }}
      >
        <ContextRail
          collapsed={collapsed}
          contents={null}
          links={null}
          history={null}
          index={null}
        />
      </PanelWidthsContext.Provider>,
    );

  expect(rail(false)).toContain('aria-label="Resize context panel"');
  expect(rail(true)).not.toContain("Resize context panel");
});
