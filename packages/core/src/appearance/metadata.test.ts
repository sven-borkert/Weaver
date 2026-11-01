import { describe, expect, it } from "vitest";
import { CoreError } from "../errors";
import {
  applyAppearancePatch,
  assertAppearancePatch,
  normalizeAppearance,
} from "./metadata";

describe("appearance metadata", () => {
  it("normalizes_hex_and_resets_only_requested_fields", () => {
    expect(normalizeAppearance({ backgroundColor: "#AABBCC" })).toEqual({
      backgroundColor: "#aabbcc",
    });
    expect(
      applyAppearancePatch({ backgroundColor: "#aabbcc" }, { icon: null }),
    ).toEqual({ backgroundColor: "#aabbcc" });
    expect(
      assertAppearancePatch({ backgroundColor: "#AABBCC", icon: null }),
    ).toEqual({ backgroundColor: "#aabbcc", icon: null });
    expect(
      applyAppearancePatch(
        {
          backgroundColor: "#aabbcc",
          icon: { type: "builtin", name: "folder" },
        },
        { backgroundColor: null },
      ),
    ).toEqual({ icon: { type: "builtin", name: "folder" } });
    expect(
      applyAppearancePatch(
        { backgroundColor: "#aabbcc" },
        { backgroundColor: null },
      ),
    ).toBeNull();
    expect(applyAppearancePatch(null, {})).toBeNull();
  });

  it("rejects_multiple_emoji_graphemes_and_controls", () => {
    expect(
      assertAppearancePatch({ icon: { type: "emoji", value: "👨‍👩‍👧‍👦" } }),
    ).toEqual({ icon: { type: "emoji", value: "👨‍👩‍👧‍👦" } });
    for (const value of [
      "😀😀",
      "",
      "😀\n",
      "\u0000",
      "\u0085",
      "a" + "\u0301".repeat(32),
    ]) {
      expect(
        normalizeAppearance({ icon: { type: "emoji", value } }),
      ).toBeNull();
      expect(() =>
        assertAppearancePatch({ icon: { type: "emoji", value } }),
      ).toThrow(CoreError);
    }
  });

  it.each([
    "\u061c",
    "\u200e",
    "\u200f",
    "\u202a",
    "\u202b",
    "\u202c",
    "\u202d",
    "\u202e",
    "\u2066",
    "\u2067",
    "\u2068",
    "\u2069",
  ])(
    "drops bidi-control icon %j while retaining valid color on read",
    (value) => {
      expect(
        normalizeAppearance({
          backgroundColor: "#AABBCC",
          icon: { type: "emoji", value },
        }),
      ).toEqual({ backgroundColor: "#aabbcc" });
      expect(
        normalizeAppearance({ icon: { type: "emoji", value } }),
      ).toBeNull();
    },
  );

  it.each(["\u200e", "\u202e", "\u2066"])(
    "rejects bidi-control icon %j with a field-pinned write error",
    (value) => {
      try {
        assertAppearancePatch({ icon: { type: "emoji", value } });
        throw new Error("accepted bidi control");
      } catch (error) {
        expect(error).toMatchObject({
          code: "BAD_REQUEST",
          details: { field: "icon" },
        });
      }
    },
  );

  it("drops_invalid_fields_independently_and_omits_empty_appearance", () => {
    expect(
      normalizeAppearance({
        backgroundColor: "red",
        icon: { type: "builtin", name: "folder" },
      }),
    ).toEqual({ icon: { type: "builtin", name: "folder" } });
    expect(
      normalizeAppearance({
        backgroundColor: "#aabbcc",
        icon: { type: "builtin", name: "unknown" },
      }),
    ).toEqual({ backgroundColor: "#aabbcc" });
    for (const raw of [
      null,
      undefined,
      [],
      "red",
      {},
      { backgroundColor: "#abc" },
      { icon: { type: "image", digest: "A".repeat(64), extension: "png" } },
    ]) {
      expect(normalizeAppearance(raw)).toBeNull();
    }
    expect(
      normalizeAppearance({
        icon: { type: "image", digest: "a".repeat(64), extension: "webp" },
      }),
    ).toEqual({
      icon: { type: "image", digest: "a".repeat(64), extension: "webp" },
    });
  });

  it("pins_invalid_mutation_values_to_the_requested_field", () => {
    for (const [field, raw] of [
      ["backgroundColor", { backgroundColor: "transparent" }],
      ["icon", { icon: { type: "image", path: "../x.png" } }],
    ] as const) {
      try {
        assertAppearancePatch(raw);
        throw new Error("accepted invalid patch");
      } catch (error) {
        expect(error).toMatchObject({
          code: "BAD_REQUEST",
          details: { field },
        });
      }
    }
    for (const raw of [
      null,
      [],
      "x",
      { unexpected: true },
      { icon: { type: "builtin", name: "folder", path: "/x" } },
    ]) {
      expect(() => assertAppearancePatch(raw)).toThrow(CoreError);
    }
    expect(assertAppearancePatch({})).toEqual({});
  });
});
