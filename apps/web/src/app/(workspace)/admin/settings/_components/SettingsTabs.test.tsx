import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ pathname: "/admin/settings/oidc" }));
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
import { SettingsTabs } from "./SettingsTabs";
describe("administration Settings tabs", () => {
  it.each(["ai", "remote-instances", "oidc"])(
    "links all tabs and marks %s current",
    (tab) => {
      state.pathname = `/admin/settings/${tab}`;
      const html = renderToStaticMarkup(<SettingsTabs />);
      expect(html).toContain('aria-label="Administration settings"');
      expect(html).toContain('href="/admin/settings/ai"');
      expect(html).toContain('href="/admin/settings/remote-instances"');
      expect(html).toContain('href="/admin/settings/oidc"');
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
      const selected = html
        .match(/<a\b[^>]*>/g)
        ?.find((anchor) => anchor.includes(`href="/admin/settings/${tab}"`));
      expect(selected).toContain('aria-current="page"');
    },
  );
});
