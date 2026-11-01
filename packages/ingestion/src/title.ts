const TITLE_MAX = 200;

export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, "");
  const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  const words = stem.replace(/[_-]+/g, " ").trim();
  if (!words) return "Untitled import";
  const cased = words.charAt(0).toUpperCase() + words.slice(1);
  return cased.slice(0, TITLE_MAX).trim();
}
