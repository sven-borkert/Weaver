/**
 * Build metadata without importing package.json, so browser bundles carry only
 * the three NEXT_PUBLIC_* values next.config.ts inlines at build time.
 */
export type BuildInfo = {
  version: string | null;
  buildTime: string | null;
  commitSha: string | null;
};

export function formatAppVersion(version: string): string {
  const trimmed = version.trim();
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

export function normalizeBuildValue(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (normalized === "") return null;
  return normalized ?? null;
}

/** Client-safe: each key must stay a literal member access so Next can inline it. */
export function getClientBuildInfo(): BuildInfo {
  const version = normalizeBuildValue(process.env.NEXT_PUBLIC_APP_VERSION);
  return {
    version: version ? formatAppVersion(version) : null,
    buildTime: normalizeBuildValue(process.env.NEXT_PUBLIC_BUILD_TIME),
    commitSha: normalizeBuildValue(process.env.NEXT_PUBLIC_COMMIT_SHA),
  };
}
