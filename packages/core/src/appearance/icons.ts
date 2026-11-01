import type { ImageIcon } from "./metadata";

export const BUILTIN_ICON_NAMES = [
  "folder",
  "file-text",
  "table",
  "book-open",
  "briefcase",
  "calendar",
  "check-circle",
  "code",
  "database",
  "file",
  "heart",
  "lightbulb",
  "star",
  "tag",
] as const;

export function isIconAssetPath(path: string): boolean {
  const match = /^\.weaver-icons\/[a-f0-9]{64}\.(png|jpg|webp)$/.exec(path);
  return match !== null && match[0] === path;
}

export function iconAssetPath(icon: ImageIcon): string {
  const path = `.weaver-icons/${icon.digest}.${icon.extension}`;
  if (!isIconAssetPath(path)) throw new Error("Invalid image icon asset");
  return path;
}
