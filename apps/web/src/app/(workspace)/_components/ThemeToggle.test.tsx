import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ theme: undefined as string | undefined }));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: mocked.theme, setTheme: vi.fn() }),
}));

import { ThemeToggle } from "./ThemeToggle";

describe("ThemeToggle", () => {
  it("renders the neutral system state before mount regardless of the stored theme", () => {
    mocked.theme = undefined;
    const serverHtml = renderToStaticMarkup(<ThemeToggle />);
    mocked.theme = "dark";
    const hydratingHtml = renderToStaticMarkup(<ThemeToggle />);

    expect(serverHtml).toContain('aria-label="Theme: system. Click to switch"');
    expect(hydratingHtml).toBe(serverHtml);
  });

  it("never renders a disabled attribute, which Firefox would restore across reloads", () => {
    mocked.theme = undefined;

    expect(renderToStaticMarkup(<ThemeToggle />)).not.toMatch(/ disabled[=>]/);
  });
});
