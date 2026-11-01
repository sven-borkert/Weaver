import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export function resolveE2eDataDir(dataDir: string): string {
  return path.resolve(repositoryRoot, dataDir);
}

export function resolveE2eGitDir(dataDir: string): string {
  return path.join(resolveE2eDataDir(dataDir), "git");
}
