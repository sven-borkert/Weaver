import { CoreError } from "../errors";
import { BUILTIN_ICON_NAMES, isIconAssetPath } from "./icons";

export { BUILTIN_ICON_NAMES } from "./icons";
export type BuiltinIconName = (typeof BUILTIN_ICON_NAMES)[number];
export type AppearanceIcon =
  | { type: "builtin"; name: BuiltinIconName }
  | { type: "emoji"; value: string }
  | { type: "image"; digest: string; extension: "png" | "jpg" | "webp" };
export type Appearance = { backgroundColor?: string; icon?: AppearanceIcon };
export type ImageIcon = Extract<AppearanceIcon, { type: "image" }>;
export type AppearancePatch = {
  backgroundColor?: string | null;
  icon?: AppearanceIcon | null;
};
export type AppearanceTarget = { projectId: string } & (
  | { kind: "document"; id: string }
  | { kind: "table"; id: string }
  | { kind: "folder"; scope: "documents" | "tables"; path: string[] }
);

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
const utf8 = new TextEncoder();

function isObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function normalizeColor(raw: unknown): string | null {
  return typeof raw === "string" &&
    raw.length === 7 &&
    /^#[a-f0-9]{6}$/i.test(raw)
    ? raw.toLowerCase()
    : null;
}

function normalizeIcon(raw: unknown): AppearanceIcon | null {
  if (!isObject(raw)) return null;
  const keys = Object.keys(raw).sort().join(",");
  if (
    raw.type === "builtin" &&
    keys === "name,type" &&
    typeof raw.name === "string" &&
    (BUILTIN_ICON_NAMES as readonly string[]).includes(raw.name)
  ) {
    return { type: "builtin", name: raw.name as BuiltinIconName };
  }
  if (
    raw.type === "emoji" &&
    keys === "type,value" &&
    typeof raw.value === "string" &&
    raw.value.length > 0 &&
    utf8.encode(raw.value).length <= 64 &&
    !/[\p{Cc}\p{Cs}\p{Bidi_Control}\u2028\u2029]/u.test(raw.value) &&
    [...graphemes.segment(raw.value)].length === 1
  ) {
    return { type: "emoji", value: raw.value };
  }
  if (
    raw.type === "image" &&
    keys === "digest,extension,type" &&
    typeof raw.digest === "string" &&
    typeof raw.extension === "string" &&
    isIconAssetPath(`.weaver-icons/${raw.digest}.${raw.extension}`)
  ) {
    return {
      type: "image",
      digest: raw.digest,
      extension: raw.extension as ImageIcon["extension"],
    };
  }
  return null;
}

/** Invalid optional fields never make otherwise readable content unavailable. */
export function normalizeAppearance(raw: unknown): Appearance | null {
  if (!isObject(raw)) return null;
  const backgroundColor = normalizeColor(raw.backgroundColor);
  const icon = normalizeIcon(raw.icon);
  if (backgroundColor === null && icon === null) return null;
  return {
    ...(backgroundColor === null ? {} : { backgroundColor }),
    ...(icon === null ? {} : { icon }),
  };
}

export function assertAppearancePatch(raw: unknown): AppearancePatch {
  if (
    !isObject(raw) ||
    Object.keys(raw).some((key) => key !== "backgroundColor" && key !== "icon")
  ) {
    throw new CoreError("BAD_REQUEST", "Invalid appearance patch", {
      field: "appearance",
    });
  }
  const patch: AppearancePatch = {};
  if (Object.hasOwn(raw, "backgroundColor")) {
    const value =
      raw.backgroundColor === null ? null : normalizeColor(raw.backgroundColor);
    if (value === null && raw.backgroundColor !== null)
      throw new CoreError("BAD_REQUEST", "Use an opaque six-digit hex color", {
        field: "backgroundColor",
      });
    patch.backgroundColor = value;
  }
  if (Object.hasOwn(raw, "icon")) {
    const value = raw.icon === null ? null : normalizeIcon(raw.icon);
    if (value === null && raw.icon !== null)
      throw new CoreError("BAD_REQUEST", "Invalid icon", { field: "icon" });
    patch.icon = value;
  }
  return patch;
}

export function applyAppearancePatch(
  current: Appearance | null,
  patch: AppearancePatch,
): Appearance | null {
  return normalizeAppearance({ ...current, ...patch });
}
