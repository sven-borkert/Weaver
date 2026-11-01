import { describe, expect, it } from "vitest";
import { currentOutlineAnchor, revealScrollTop } from "./outline-scroll-spy";

const headings = [
  { anchor: "section-a", top: -400 },
  { anchor: "section-b", top: 90 },
  { anchor: "section-c", top: 500 },
  { anchor: "section-d", top: 700 },
];

describe("current outline section", () => {
  it("is the last heading at or above the reading line", () => {
    expect(
      currentOutlineAnchor({
        headings,
        readingLine: 100,
        viewportBottom: 800,
        atEnd: false,
      }),
    ).toBe("section-b");
    expect(
      currentOutlineAnchor({
        headings,
        readingLine: 80,
        viewportBottom: 800,
        atEnd: false,
      }),
    ).toBe("section-a");
  });

  it("is nothing before the first heading", () => {
    expect(
      currentOutlineAnchor({
        headings: headings.slice(1),
        readingLine: 80,
        viewportBottom: 800,
        atEnd: false,
      }),
    ).toBeUndefined();
    expect(
      currentOutlineAnchor({
        headings: [],
        readingLine: 80,
        viewportBottom: 800,
        atEnd: true,
      }),
    ).toBeUndefined();
  });

  it("is the last visible heading once the end of the document is reached", () => {
    expect(
      currentOutlineAnchor({
        headings,
        readingLine: 100,
        viewportBottom: 800,
        atEnd: true,
      }),
    ).toBe("section-d");
    expect(
      currentOutlineAnchor({
        headings,
        readingLine: 100,
        viewportBottom: 600,
        atEnd: true,
      }),
    ).toBe("section-c");
  });
});

describe("revealing the current entry", () => {
  const view = { scrollTop: 200, viewTop: 100, viewBottom: 400 };

  it("leaves a visible entry alone", () => {
    expect(revealScrollTop({ ...view, itemTop: 150, itemBottom: 180 })).toBe(
      undefined,
    );
  });

  it("scrolls up or down just far enough to show the entry", () => {
    expect(revealScrollTop({ ...view, itemTop: 60, itemBottom: 90 })).toBe(160);
    expect(revealScrollTop({ ...view, itemTop: 390, itemBottom: 430 })).toBe(
      230,
    );
  });
});
