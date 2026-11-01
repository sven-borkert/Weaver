import { normalizeBasePath } from "@weaver/config/publicUrls";

/** Restores the public app prefix before Better Auth matches its baseURL path. */
export function withAuthRequestBasePath(
  request: Request,
  basePath = process.env.NEXT_PUBLIC_BASE_PATH,
): Request {
  const normalizedBasePath = normalizeBasePath(basePath);
  if (!normalizedBasePath) return request;

  const url = new URL(request.url);
  if (
    url.pathname === normalizedBasePath ||
    url.pathname.startsWith(`${normalizedBasePath}/`)
  ) {
    return request;
  }

  url.pathname = `${normalizedBasePath}${url.pathname}`;
  return new Request(url, request);
}
