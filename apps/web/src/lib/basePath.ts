export const APP_BASE_PATH = normalizeBasePath(
  process.env.NEXT_PUBLIC_BASE_PATH,
);

export function normalizeBasePath(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw || raw === "/") return "";
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

export function withBasePath(path: string, basePath = APP_BASE_PATH): string {
  const normalizedBasePath = normalizeBasePath(basePath);
  if (!normalizedBasePath) return path;
  if (!path.startsWith("/") || path.startsWith("//") || isAbsoluteUrl(path)) {
    return path;
  }
  if (
    path === normalizedBasePath ||
    path.startsWith(`${normalizedBasePath}/`) ||
    path.startsWith(`${normalizedBasePath}?`) ||
    path.startsWith(`${normalizedBasePath}#`)
  ) {
    return path;
  }
  return `${normalizedBasePath}${path}`;
}

export function publicUrlWithBasePath(
  publicUrl: string,
  path: string,
  basePath = APP_BASE_PATH,
): string {
  const base = new URL(publicUrl);
  return `${base.origin}${withBasePath(path, basePath)}`;
}

export function stripBasePath(path: string, basePath = APP_BASE_PATH): string {
  const normalizedBasePath = normalizeBasePath(basePath);
  if (!normalizedBasePath) return path;
  if (path === normalizedBasePath) return "/";
  if (
    path.startsWith(`${normalizedBasePath}?`) ||
    path.startsWith(`${normalizedBasePath}#`)
  )
    return `/${path.slice(normalizedBasePath.length)}`;
  if (path.startsWith(`${normalizedBasePath}/`)) {
    return path.slice(normalizedBasePath.length) || "/";
  }
  return path;
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z\d+\-.]*:/i.test(value);
}
