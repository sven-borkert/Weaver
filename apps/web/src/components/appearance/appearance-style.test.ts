import { describe, expect, it } from "vitest";
import { appearanceStyle } from "./appearance-style";
import { readExplorerIconSize } from "~/lib/explorer/entries";

describe("appearanceStyle", () => {
  it("reset_restores_default_background", () => {
    expect(appearanceStyle(null)).toEqual({});
    expect(appearanceStyle({ icon: { type: "emoji", value: "⭐" } })).toEqual(
      {},
    );
  });
  it.each([
    ["#000000", "#ffffff"],
    ["#ffffff", "#000000"],
    ["#ffcc00", "#000000"],
    ["#223355", "#ffffff"],
  ])("keeps visible text on %s", (backgroundColor, color) => {
    expect(appearanceStyle({ backgroundColor })).toMatchObject({
      backgroundColor,
      color,
    });
  });
  it("blocked_local_storage_defaults_to_standard", () => {
    expect(
      readExplorerIconSize(
        {
          getItem: () => {
            throw new Error("blocked");
          },
        },
        "view",
      ),
    ).toBe("standard");
    expect(
      readExplorerIconSize(
        { getItem: (key) => (key === "view:iconSize" ? "compact" : null) },
        "view",
      ),
    ).toBe("compact");
    expect(readExplorerIconSize({ getItem: () => "invalid" }, "view")).toBe(
      "standard",
    );
  });
});
