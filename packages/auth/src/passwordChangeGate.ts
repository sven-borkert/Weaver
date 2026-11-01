/**
 * The Better Auth routes a `mustChangePassword` user may still reach. The
 * shared before hook in `createWeaverAuth` rejects every other
 * cookie-authenticated request (HTTP or in-process `auth.api.*`) with
 * FORBIDDEN — the same allowlist posture as the web app's `requireActiveUser`.
 *
 * `/oauth2/authorize` is allowed because the OAuth provider's `postLogin`
 * redirect (also configured in `createWeaverAuth`) turns a flagged user's
 * authorization into a consent-page visit that the page denies; the
 * provider never reaches its existing-consent shortcut for them.
 */
export const PASSWORD_CHANGE_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  "/sign-in/email",
  "/get-session",
  "/sign-out",
  "/change-password",
  "/oauth2/authorize",
]);

/** Strict boolean: the session user's additional field, never a truthy string. */
export function isPasswordChangeRequired(
  user: object | null | undefined,
): boolean {
  if (!user || !("mustChangePassword" in user)) return false;
  return user.mustChangePassword === true;
}

export function isAllowedWhilePasswordChangeRequired(
  path: string,
  body: unknown,
): boolean {
  if (PASSWORD_CHANGE_ALLOWED_PATHS.has(path)) return true;
  // A consent *denial* is how the consent page aborts a flagged user's
  // in-flight authorization; only `accept === true` would mint a code.
  if (path === "/oauth2/consent") {
    return !(
      typeof body === "object" &&
      body !== null &&
      (body as { accept?: unknown }).accept === true
    );
  }
  return false;
}
