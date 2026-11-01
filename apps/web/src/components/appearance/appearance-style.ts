import type { CSSProperties } from "react";
import type { Appearance } from "@weaver/core/appearance/metadata";

export function appearanceStyle(appearance: Appearance | null): CSSProperties {
  const backgroundColor = appearance?.backgroundColor;
  if (!backgroundColor) return {};
  const channels = [1, 3, 5].map((start) => {
    const value = parseInt(backgroundColor.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance =
    channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  return { backgroundColor, color: luminance > 0.179 ? "#000000" : "#ffffff" };
}
