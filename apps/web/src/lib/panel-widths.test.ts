import { describe, expect, it } from "vitest";

import {
  DEFAULT_PANEL_WIDTHS,
  PANEL_WIDTH_COOKIES,
  dragPanelWidth,
  keyboardPanelWidth,
  maxPanelWidth,
  parsePanelWidthCookie,
  serializePanelWidthCookie,
} from "./panel-widths";

describe("panel widths", () => {
  it("defaults to the design widths", () => {
    expect(DEFAULT_PANEL_WIDTHS).toEqual({ sidebar: 278, contextRail: 320 });
  });

  it("reads a stored width and clamps it into range", () => {
    expect(parsePanelWidthCookie("sidebar", "300")).toBe(300);
    expect(parsePanelWidthCookie("sidebar", "90")).toBe(200);
    expect(parsePanelWidthCookie("sidebar", "9000")).toBe(400);
    expect(parsePanelWidthCookie("contextRail", "333.7")).toBe(334);
    expect(parsePanelWidthCookie("contextRail", "wide")).toBe(320);
    expect(parsePanelWidthCookie("contextRail", "")).toBe(320);
    expect(parsePanelWidthCookie("contextRail", undefined)).toBe(320);
  });

  it("writes a year-long cookie scoped to the base path", () => {
    expect(serializePanelWidthCookie("sidebar", 300, "/weaver")).toBe(
      `${PANEL_WIDTH_COOKIES.sidebar}=300; Path=/weaver; Max-Age=31536000; SameSite=Lax`,
    );
    expect(serializePanelWidthCookie("contextRail", 360.4, "")).toBe(
      `${PANEL_WIDTH_COOKIES.contextRail}=360; Path=/; Max-Age=31536000; SameSite=Lax`,
    );
  });

  it("caps the widest setting by the window but never below the default", () => {
    expect(maxPanelWidth("sidebar", 1440)).toBe(400);
    expect(maxPanelWidth("sidebar", 900)).toBe(315);
    expect(maxPanelWidth("sidebar", 700)).toBe(278);
    expect(maxPanelWidth("contextRail", 1440)).toBe(560);
    expect(maxPanelWidth("contextRail", 1280)).toBe(512);
  });

  it("grows the sidebar rightwards and the context rail leftwards", () => {
    const drag = { startWidth: 300, startX: 500, viewportWidth: 1440 };
    expect(dragPanelWidth("sidebar", { ...drag, x: 540 })).toBe(340);
    expect(dragPanelWidth("contextRail", { ...drag, x: 540 })).toBe(260);
    expect(dragPanelWidth("contextRail", { ...drag, x: 400 })).toBe(400);
  });

  it("stops a drag at the minimum and the window cap", () => {
    const drag = { startWidth: 300, startX: 500, viewportWidth: 1280 };
    expect(dragPanelWidth("sidebar", { ...drag, x: 0 })).toBe(200);
    expect(dragPanelWidth("contextRail", { ...drag, x: 0 })).toBe(512);
  });

  it("moves the divider 16px per arrow key", () => {
    expect(keyboardPanelWidth("sidebar", 300, "ArrowRight", 1440)).toBe(316);
    expect(keyboardPanelWidth("sidebar", 300, "ArrowLeft", 1440)).toBe(284);
    expect(keyboardPanelWidth("contextRail", 300, "ArrowLeft", 1440)).toBe(316);
    expect(keyboardPanelWidth("contextRail", 262, "ArrowRight", 1440)).toBe(
      260,
    );
    expect(keyboardPanelWidth("sidebar", 300, "Enter", 1440)).toBeUndefined();
  });
});
