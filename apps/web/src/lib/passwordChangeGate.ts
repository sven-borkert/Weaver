import { APP_BASE_PATH, stripBasePath } from "./basePath";

/** App-relative (no base path) route the forced-change redirect targets. */
export const ACCOUNT_PASSWORD_PATH = "/account/password";

/**
 * Pure redirect decision for the `(workspace)` layout's forced-change gate.
 * `requestPath` is the raw value of the `x-weaver-request-path` header
 * `proxy.ts` forwards — base-path-prefixed, exact same convention
 * `safeLoginCallbackUrl` already strips.
 *
 * Defaults to NOT redirecting whenever the destination can't be positively
 * read (missing header, unrecognized shape): the two mistakes are not
 * symmetric. A false "don't redirect" only delays the UX nudge — the tRPC
 * gate still blocks every other procedure. A false "redirect" while already
 * on the password page is a permanent lockout with no email recovery, so
 * every ambiguous case must resolve toward staying put.
 */
export function shouldRedirectToChangePassword(
  mustChangePassword: boolean,
  requestPath: string | null | undefined,
  basePath: string = APP_BASE_PATH,
): boolean {
  if (!mustChangePassword) return false;
  if (!requestPath) return false;
  const strippedPath = stripBasePath(requestPath, basePath);
  const pathname = strippedPath.split(/[?#]/)[0];
  return pathname !== ACCOUNT_PASSWORD_PATH;
}
