import packageJson from "../../../../package.json";

import { formatAppVersion, normalizeBuildValue } from "./buildInfo";

type Env = Record<string, string | undefined>;

export type AppVersionInfo = {
  version: string;
  buildTime: string | null;
  commitSha: string | null;
};

export { formatAppVersion };

const BUILD_TIME_ENV_KEYS = [
  "APP_BUILD_TIME",
  "NEXT_PUBLIC_BUILD_TIME",
] as const;

const COMMIT_SHA_ENV_KEYS = [
  "APP_COMMIT_SHA",
  "NEXT_PUBLIC_COMMIT_SHA",
  "VERCEL_GIT_COMMIT_SHA",
  "GIT_COMMIT_SHA",
] as const;

export const APP_VERSION = formatAppVersion(packageJson.version);

export function getAppVersionInfo(env?: Env): AppVersionInfo {
  return {
    version: APP_VERSION,
    buildTime: env
      ? firstEnvValue(env, BUILD_TIME_ENV_KEYS)
      : firstValue(
          process.env.APP_BUILD_TIME,
          process.env.NEXT_PUBLIC_BUILD_TIME,
        ),
    commitSha: env
      ? firstEnvValue(env, COMMIT_SHA_ENV_KEYS)
      : firstValue(
          process.env.APP_COMMIT_SHA,
          process.env.NEXT_PUBLIC_COMMIT_SHA,
          process.env.VERCEL_GIT_COMMIT_SHA,
          process.env.GIT_COMMIT_SHA,
        ),
  };
}

function firstEnvValue(env: Env, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = normalizeBuildValue(env[key]);
    if (value) return value;
  }
  return null;
}

function firstValue(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    const normalized = normalizeBuildValue(value);
    if (normalized) return normalized;
  }
  return null;
}
