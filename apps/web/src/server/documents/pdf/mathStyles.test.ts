import { describe, expect, it } from "vitest";
import { mathStylesSource } from "./mathStyles";

describe("mathStylesSource", () => {
  it("inlines every KaTeX font", async () => {
    const css = await mathStylesSource();
    expect(css).toContain(".katex");
    expect(css).toContain("data:font/woff2;base64,");
    expect(css).not.toContain("url(fonts/");
    expect(css).not.toMatch(/<\/style/i);
  });
});
