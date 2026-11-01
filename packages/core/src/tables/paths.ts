import { PathError, assertSafeSegments } from "@weaver/core/documents/paths";

export const TABLES_ROOT = "tables";
export const TABLE_DIR_SUFFIX = ".table";
export const TABLE_DIR_RE = /^[a-z0-9][a-z0-9-]{0,79}\.table$/;

export function tableDirName(slug: string): string {
  return `${slug}${TABLE_DIR_SUFFIX}`;
}

export function isTableDirName(name: string): boolean {
  return TABLE_DIR_RE.test(name);
}

export function slugFromTableDir(name: string): string {
  if (!TABLE_DIR_RE.test(name)) {
    throw new PathError(`invalid table directory: ${JSON.stringify(name)}`);
  }
  return name.slice(0, -TABLE_DIR_SUFFIX.length);
}

/** Repo-relative directory of a table: tables/<folders…>/<slug>.table */
export function tableDirPath(folderPath: string[], slug: string): string {
  assertSafeSegments(folderPath);
  const dir = tableDirName(slug);
  if (!TABLE_DIR_RE.test(dir)) {
    throw new PathError(`invalid table slug: ${JSON.stringify(slug)}`);
  }
  return [TABLES_ROOT, ...folderPath, dir].join("/");
}

/** Folder segments beneath TABLES_ROOT for a repo-relative table dir. */
export function folderPathOfTableDir(dir: string): string[] {
  return dir.split("/").slice(1, -1);
}

/** Documents-scope paths must never reach into the reserved tables root. */
export function assertOutsideTablesRoot(segments: string[]): void {
  if (segments[0] === TABLES_ROOT || segments[0] === ".weaver-icons") {
    throw new PathError(`"${segments[0]}" is a reserved content root`);
  }
}
