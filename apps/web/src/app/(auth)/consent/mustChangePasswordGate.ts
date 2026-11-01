import type { WeaverAuth } from "@weaver/auth";

import { ACCOUNT_PASSWORD_PATH } from "~/lib/passwordChangeGate";

export type SearchParams = Record<string, string | string[] | undefined>;

/** Reconstructs the page's raw query string, preserving repeated keys (e.g. Better Auth's `ba_param`). */
export function buildQueryString(params: SearchParams): string {
  return new URLSearchParams(
    Object.entries(params).flatMap(([key, value]) =>
      (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(
        (v) => [key, v] as [string, string],
      ),
    ),
  ).toString();
}

/**
 * Aborts an in-flight OAuth authorization the same way the consent page's own
 * "Deny" button would (`POST /oauth2/consent` with `accept: false`), so a
 * waiting client gets a spec-compliant `access_denied` redirect instead of
 * hanging. Used to keep a `mustChangePassword` user from ever seeing an
 * approvable consent form.
 *
 * Any failure — missing, malformed, or unsigned `oauth_query`, an expired
 * signature, no authorization in flight — falls back to
 * `ACCOUNT_PASSWORD_PATH`: there is nothing meaningful to deny, and the
 * consent page must never throw instead of rendering.
 */
export async function denyFlaggedConsent(
  auth: Pick<WeaverAuth, "api">,
  params: SearchParams,
  requestHeaders: Headers,
): Promise<string> {
  try {
    const result = (await auth.api.oauth2Consent({
      body: { accept: false, oauth_query: buildQueryString(params) },
      headers: requestHeaders,
    })) as { url?: string; redirect_uri?: string } | null;
    return result?.url ?? result?.redirect_uri ?? ACCOUNT_PASSWORD_PATH;
  } catch {
    return ACCOUNT_PASSWORD_PATH;
  }
}
