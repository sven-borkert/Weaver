import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ClientDate, ClientDateTime } from "./client-date";

const value = new Date("2026-09-08T05:00:00Z");

describe("client date components", () => {
  it("renders a distinct placeholder per variant before mount", () => {
    expect(renderToStaticMarkup(<ClientDate value={value} />)).toBe(
      '<span aria-label="Date loading">—</span>',
    );
    expect(renderToStaticMarkup(<ClientDateTime value={value} />)).toBe(
      '<span aria-label="Date and time loading">—</span>',
    );
  });
});
