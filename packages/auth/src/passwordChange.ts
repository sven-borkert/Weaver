import type { WeaverAuth } from "./index";

export type PasswordChanger = {
  change(input: {
    headers: Headers;
    currentPassword: string;
    newPassword: string;
  }): Promise<{ setCookies: string[] }>;
};

/**
 * Wraps Better Auth's own `/change-password` endpoint in process; the HTTP
 * route is disabled (`DISABLED_ACCOUNT_PATHS`) so every change runs under
 * core's per-user credential lock. Unlike `UserAdministrator`'s methods, this one legitimately
 * needs the caller's real request headers: the endpoint re-resolves the
 * session from the cookie and verifies `currentPassword` against that same
 * account, so it must run the plugin's normal headers-authenticated path
 * rather than the `internalAdapter` bypass `adminUsers.ts` uses for actions
 * an admin takes on someone else's account.
 */
export function createPasswordChanger(auth: WeaverAuth): PasswordChanger {
  return {
    async change(input) {
      const result = await auth.api.changePassword({
        body: {
          currentPassword: input.currentPassword,
          newPassword: input.newPassword,
          revokeOtherSessions: true,
        },
        headers: input.headers,
        returnHeaders: true,
      });
      return { setCookies: result.headers.getSetCookie() };
    },
  };
}
