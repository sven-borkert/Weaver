import { describe, expect, it } from "vitest";

import {
  isSidebarCollapsedCookie,
  serializeSidebarCookie,
  SIDEBAR_COOKIE_NAME,
} from "./sidebar-state";

describe("sidebar-state", () => {
  it("treats only the collapsed value as collapsed", () => {
    expect(isSidebarCollapsedCookie("collapsed")).toBe(true);
    expect(isSidebarCollapsedCookie("expanded")).toBe(false);
    expect(isSidebarCollapsedCookie("")).toBe(false);
    expect(isSidebarCollapsedCookie(undefined)).toBe(false);
  });

  it("serializes a persistent site-wide cookie that round-trips", () => {
    const collapsed = serializeSidebarCookie(true);
    expect(collapsed.startsWith(`${SIDEBAR_COOKIE_NAME}=collapsed;`)).toBe(
      true,
    );
    expect(collapsed).toContain("Path=/");
    expect(collapsed).toContain("Max-Age=31536000");
    expect(collapsed).toContain("SameSite=Lax");
    expect(
      isSidebarCollapsedCookie(collapsed.split(";")[0]!.split("=")[1]),
    ).toBe(true);
    expect(
      isSidebarCollapsedCookie(
        serializeSidebarCookie(false).split(";")[0]!.split("=")[1],
      ),
    ).toBe(false);
  });
});
