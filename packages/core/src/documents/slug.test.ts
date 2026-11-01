import { describe, expect, it } from "vitest";
import { slugify } from "./slug";

describe("slugify", () => {
  it("kebab-cases and ascii-folds", () => {
    expect(slugify("Getting Started")).toBe("getting-started");
    expect(slugify("Über uns — Café")).toBe("uber-uns-cafe");
  });
  it("collapses separators and trims hyphens", () => {
    expect(slugify("  a__b  //c  ")).toBe("a-b-c");
  });
  it("falls back to 'untitled' when nothing survives", () => {
    expect(slugify("!!! ???")).toBe("untitled");
  });
  it("caps at 80 chars without trailing hyphen", () => {
    const s = slugify("x".repeat(200));
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s.endsWith("-")).toBe(false);
  });
});
